import { maxSeverity, type Deduction, type Evidence, type Fact, type FindingDraft, type Severity } from '../finding'
import type { Rule, RuleContext } from '../rule'
import type { CadenceShift, GapInfo } from '../streamModel'
import type { StatSnapshot } from '../stats'
import { CADENCE_TOLERANCE_PERCENT, stallLimit } from '../stallLimit'
import { ev, fmtMs, plural } from './util'

/**
 * R05 stall.silent: the stream stopped delivering.
 *
 * Three clocks are judged separately (any byte, origin byte, complete event) because each tells a different story:
 *   (i)   `no-bytes`  the connection is open and not one body byte has arrived;
 *   (ii)  `events`    bytes (heartbeats) keep arriving but no event does;
 *   (iv)  `origin`    only the PROXY's heartbeats arrive, the origin has gone quiet: a masked upstream stall;
 *   -     `bytes`     nothing at all arrives after the stream had started.
 * (iii) a frame started but never completed needs the parser's pendingBytes, which is not recorded yet.
 * TODO(R05-iii): evaluate "partial frame stuck" once the recorder carries pendingBytes.
 *
 * A gap is silence on one clock. Gaps that ended (next byte, or the connection leaving `open`) are judged once, in
 * `onObservation`. A gap still going is judged in `onTick` (without changing state) and in `onEnd`.
 * Silence is not judged when the connection is not open, before the first byte of the connection (that is (i)), or
 * across a clock discontinuity (measuring restarts at the jump).
 *
 * A stall is `resolved` when data resumes on its own connection. One that ended because the connection closed stays `open`
 * until a LATER connection delivers an event, which resolves it (decided: results Q12); the finding keeps what it was. A capture
 * that ends in a stall (open, or closed with no later event) still has it open.
 * A gap longer than its limit is not added to the cadence the next gap is judged by (StreamModel.baseline, results Q13).
 */

type Subtype = 'no-bytes' | 'bytes' | 'origin' | 'events'

interface Verdict {
    subtype: Subtype
    durationMs: number
    warnMs: number
    errorMs?: number | undefined
    basis: 'cadence' | 'profile' | 'none'
    severity: Severity
}

interface Episodes { count: number; firstSeenT: number; severity: Severity }

const RULE_ID = 'stall.silent'
const keyOf = (s: Subtype) => `${RULE_ID}:${s}`

const TITLES: Record<Subtype, string> = {
    'no-bytes': 'Connection open but no data arrived',
    bytes: 'Stream went silent',
    origin: 'Origin silent while the proxy keeps the connection alive',
    events: 'Heartbeats arriving but no events',
}

function judge(gap: GapInfo, endT: number, { thresholds: th, profile }: RuleContext): Verdict | undefined {
    const durationMs = endT - gap.startT
    if (durationMs < th.stallMinSilenceMs) return undefined

    let subtype: Subtype
    if (gap.clock === 'byte') subtype = gap.startKind === 'open' ? 'no-bytes' : 'bytes'
    else if (gap.clock === 'origin') {
        if (gap.proxyCount === 0) return undefined // without proxy bytes this is the same silence as the byte clock
        subtype = 'origin'
    } else {
        if (gap.aliveChunks === 0) return undefined
        subtype = 'events'
    }

    const heartbeatMs = gap.hbMedianMs ?? profile.expected?.heartbeatMs
    // The limit is the stream's rhythm so far, and that rhythm holds no gap that was itself a stall (see StreamModel.closeGap).
    const { warnMs, errorMs, basis } = stallLimit(gap.stats, heartbeatMs, th, profile, subtype !== 'no-bytes')
    // An event gap is only a finding when the stream has its own measured rhythm to compare with, and bytes were
    // really alive throughout (otherwise the byte clock already reports the silence).
    if (subtype === 'events') {
        if (basis !== 'cadence') return undefined
        const quietest = Math.max(gap.maxByteGapMs, gap.lastByteT === undefined ? 0 : endT - gap.lastByteT)
        if (quietest > warnMs) return undefined
    }
    if (durationMs <= warnMs) return undefined
    return { subtype, durationMs, warnMs, errorMs, basis, severity: errorMs !== undefined && durationMs > errorMs ? 'error' : 'warning' }
}

function thresholdFact(gap: GapInfo, v: Verdict): string {
    if (v.basis === 'cadence') {
        const hb = gap.hbMedianMs !== undefined ? `, heartbeat interval ${fmtMs(gap.hbMedianMs)}` : ''
        return `The threshold was ${fmtMs(v.warnMs)} (${fmtMs(v.errorMs ?? v.warnMs)} for an error), set from this stream's own rhythm: p95 gap ${fmtMs(gap.stats.p95 ?? 0)} over ${plural(gap.stats.count, 'gap')}${hb}.`
    }
    if (v.basis === 'profile') return `The threshold was ${fmtMs(v.warnMs)}, the longest silence the stream profile allows.`
    return `The threshold was ${fmtMs(v.warnMs)}: the stream has no measured cadence yet, so the default applies.`
}

function describe(gap: GapInfo, v: Verdict, final: boolean): { facts: Fact[]; deductions: Deduction[]; summary: string; limits: string[]; nextCheck: FindingDraft['nextCheck'] } {
    const startNote = gap.startKind === 'open' ? 'connection opened' : gap.startKind === 'discontinuity' ? 'clock jump, measuring restarted here' : gap.clock === 'event' ? 'last complete event' : gap.clock === 'origin' ? 'last origin output' : 'last byte'
    const evidence: Evidence[] = [ev(gap.startSeq, gap.startT, startNote)]
    if (gap.endSeq !== undefined && gap.endT !== undefined) evidence.push(ev(gap.endSeq, gap.endT, gap.via === 'close' ? 'connection ended' : 'data resumed'))
    const length = fmtMs(v.durationMs)
    const basis = [gap.startSeq, ...(gap.endSeq !== undefined ? [gap.endSeq] : [])]
    const measured = final ? length : `${length} so far`

    const facts: Fact[] = []
    let statement: string
    let alternatives: string[]
    let summary: string
    switch (v.subtype) {
        case 'no-bytes':
            facts.push({ text: `The connection opened at t=${fmtMs(gap.startT)} and no body byte arrived for ${measured}.`, evidence })
            statement = 'Likely: the server sent headers but has not flushed any body bytes (a stuck handler, or a proxy holding the response).'
            alternatives = ['The producer has nothing to send yet and sends no heartbeat.', 'A proxy or CDN is buffering the response.', 'A network path that stalls after the headers.']
            summary = `The connection is open but no data has arrived for ${measured}.`
            break
        case 'origin':
            facts.push({ text: `${plural(gap.proxyCount, 'proxy comment')} arrived, but nothing came from the origin for ${measured}.`, evidence })
            statement = 'Likely: the upstream stopped sending while the proxy kept the connection alive with its own heartbeats.'
            alternatives = ['The upstream is legitimately idle (no events to send).', 'Upstream data is buffered between the origin and the proxy.']
            summary = `Only the proxy is talking: the origin has been silent for ${measured}.`
            break
        case 'events':
            facts.push({ text: `${plural(gap.aliveChunks, 'chunk')} arrived, but no complete event for ${measured}.`, evidence })
            statement = 'Likely: the producer stopped emitting events although the connection is alive.'
            alternatives = ['No business events occurred in that period.', 'The producer logic is stuck while its heartbeat timer still runs.', 'Events are held back by an intermediary that forwards only comments.']
            summary = `Heartbeats are arriving but no event for ${measured}.`
            break
        default:
            // After a clock jump the silence is counted from the jump, which is not a byte: the text must not call it "the last byte".
            facts.push({ text: gap.startKind === 'discontinuity'
                ? `No bytes arrived for ${measured}, counted from t=${fmtMs(gap.startT)}, where a clock jump made the earlier silence unmeasurable.`
                : `No bytes arrived for ${measured}, after the last byte at t=${fmtMs(gap.startT)}.`, evidence })
            statement = v.basis === 'cadence'
                ? `Likely: the producer or a network hop stopped delivering; the silence is far beyond this stream's own rhythm.`
                : 'Likely: the stream stalled, or the producer is idle and sends no heartbeat.'
            alternatives = ['A legitimate idle period.', 'An intermediary dropped the connection without closing it.', 'The tab or process was throttled or suspended.']
            summary = `No data for ${measured}.`
    }
    facts.push({ text: thresholdFact(gap, v), evidence: [] })
    if (gap.via === 'close') facts.push({ text: `The connection then ended after ${length} of silence.`, evidence: gap.endSeq !== undefined && gap.endT !== undefined ? [ev(gap.endSeq, gap.endT, 'phase change')] : [] })

    const confident = v.basis === 'cadence' && v.severity === 'error'
    const limits = ['Tab visibility is not recorded, so background throttling is not ruled out.']
    if (v.basis === 'none') limits.unshift('No cadence is known for this stream: cannot tell stall from legitimate idle.')
    if (v.subtype === 'origin') limits.push('Until a proxy comment is seen a chunk counts as origin data; after that only parsed origin output (events, origin comments, retry hints) advances the origin clock, so bytes that produce no output are not attributed to the origin.')
    return {
        facts,
        deductions: [{ statement, confidence: confident ? 'medium' : 'low', basis, alternatives }],
        summary,
        limits,
        nextCheck: v.subtype === 'origin'
            ? { description: 'Connect to the origin directly, bypassing the proxy, and see whether it is also silent.', command: 'curl -N -H "Accept: text/event-stream" "$ORIGIN_URL"' }
            : { description: 'Request the same stream directly with curl and see whether bytes arrive when the client sees none.', command: 'curl -N -H "Accept: text/event-stream" "$URL"' },
    }
}

const CLOCK_LABEL: Record<GapInfo['clock'], string> = { byte: 'between bytes', origin: 'between origin outputs', event: 'between complete events' }
const CLOCK_START: Record<GapInfo['clock'], string> = { byte: 'last byte', origin: 'last origin output', event: 'last complete event' }

/**
 * The informational finding for a cadence change (results Q13): the old and the new rhythm, the three silences with evidence, and the plain
 * statement that this is inferred from the stream's own intervals. It is `open` like every note; it is not a failure (severity info).
 */
function cadenceChanged(shift: CadenceShift, last: GapInfo, stallKey: string, now: StatSnapshot, { thresholds: th, profile }: RuleContext, seen: Map<string, { count: number; firstSeenT: number }>): FindingDraft {
    const key = `cadence.changed:${stallKey.slice(stallKey.indexOf(':') + 1)}`
    const label = CLOCK_LABEL[shift.clock]
    const startNote = CLOCK_START[shift.clock]
    const heartbeatMs = last.hbMedianMs ?? profile.expected?.heartbeatMs
    const before = stallLimit(shift.before, heartbeatMs, th, profile)
    const after = stallLimit(now, heartbeatMs, th, profile)
    const endT = shift.gaps.at(-1)!.endT
    const prior = seen.get(key)
    const next = { count: (prior?.count ?? 0) + 1, firstSeenT: prior?.firstSeenT ?? endT }
    seen.set(key, next)

    const was = before.basis === 'cadence'
        ? `Before, the stream's own rhythm was a p95 gap of ${fmtMs(shift.before.p95 ?? 0)} over ${plural(shift.before.count, 'gap')}, so a silence beyond ${fmtMs(before.warnMs)} was a stall.`
        : `Before, the stream had no rhythm of its own to compare with (${plural(shift.before.count, 'gap')} seen), so a silence beyond ${fmtMs(before.warnMs)} was a stall (${before.basis === 'profile' ? 'the longest silence the stream profile allows' : 'the default'}).`
    const lengths = shift.gaps.map((g) => fmtMs(g.lengthMs))
    const facts: Fact[] = [
        { text: was, evidence: [] },
        { text: `Three consecutive silences were each beyond that limit and agree with each other within ${CADENCE_TOLERANCE_PERCENT}% of their median: ${lengths[0]}, ${lengths[1]} and ${lengths[2]} (median ${fmtMs(shift.medianMs)}).`, evidence: [] },
        ...shift.gaps.map((g, i): Fact => ({ text: `Silence ${i + 1}: ${fmtMs(g.lengthMs)}, after the ${startNote} at t=${fmtMs(g.startT)}.`, evidence: [ev(g.startSeq, g.startT, startNote), ev(g.endSeq, g.endT, 'data resumed')] })),
        { text: `From here on the stream's own rhythm is the new one: a silence beyond ${fmtMs(after.warnMs)} is a stall.`, evidence: [] },
    ]
    const change = shift.before.median !== undefined && shift.before.count > 0
        ? `changed from about ${fmtMs(shift.before.median)} to about ${fmtMs(shift.medianMs)}`
        : `settled at about ${fmtMs(shift.medianMs)} after it had no measured rhythm`
    return {
        key,
        title: 'Delivery cadence changed',
        summary: `The gaps ${label} ${change}, inferred from three consecutive silences.`,
        severity: 'info',
        facts,
        deductions: [{
            statement: 'Likely: the producer, or the path to it, now delivers on a slower schedule than before (a changed timer, a different load, a different server). This is inferred from the stream\'s own intervals; it is not proof of what the producer intended.',
            confidence: 'low',
            basis: shift.gaps.flatMap((g) => [g.startSeq, g.endSeq]),
            alternatives: ['A lasting fault that makes every silence long: the stalls stay on record as history, and a silence beyond the new limit is reported again.', 'A throttled tab or an intermediary that now releases data on a schedule of its own.'],
        }],
        nextCheck: { description: 'Ask whoever runs the producer whether the new rhythm is intended. If it is, declare the longest silence you accept (expected.maxSilenceMs in the stream profile): a declared limit is never overridden by this inference.' },
        limits: [
            `A cadence change is inferred from the stream's own intervals (three consecutive silences on one connection within ${CADENCE_TOLERANCE_PERCENT}% of their median); it says what the stream did, not why.`,
            'A longest silence declared in the stream profile (expected.maxSilenceMs) is never overridden: a cadence that breaks it is not learned, and its silences stay stalls.',
        ],
        status: 'open', firstSeenT: next.firstSeenT, lastSeenT: endT, occurrences: next.count,
    }
}

export const stallSilent: Rule = {
    id: RULE_ID,
    version: 1,
    title: 'Silent stream',
    requires: ['phases', 'chunks'],
    create(ctx) {
        const episodes = new Map<string, Episodes>()
        /** Stalls that ended with their connection closing, as last reported (open), and the connection they were on. */
        const unresolved = new Map<string, { draft: FindingDraft; conn: number }>()
        /** Cadence changes recognised so far, per kind of silence. */
        const cadences = new Map<string, { count: number; firstSeenT: number }>()

        const build = (gap: GapInfo, endT: number, final: boolean): { draft: FindingDraft; next: Episodes } | undefined => {
            const v = judge(gap, endT, ctx)
            if (!v) return undefined
            const key = keyOf(v.subtype)
            const prior = episodes.get(key)
            const d = describe(gap, v, final)
            const next: Episodes = {
                count: (prior?.count ?? 0) + 1,
                firstSeenT: prior?.firstSeenT ?? gap.startT + v.warnMs,
                severity: prior ? maxSeverity(prior.severity, v.severity) : v.severity,
            }
            return {
                next,
                draft: {
                    key, title: TITLES[v.subtype], summary: d.summary, severity: next.severity,
                    facts: d.facts, deductions: d.deductions, nextCheck: d.nextCheck, limits: d.limits,
                    status: final && gap.via === 'next' ? 'resolved' : 'open',
                    firstSeenT: next.firstSeenT, lastSeenT: endT, occurrences: next.count,
                },
            }
        }

        return {
            onObservation(o, model) {
                const out: FindingDraft[] = []
                const drafts = new Map<GapInfo, FindingDraft>()
                for (const gap of model.delta.gaps) {
                    const built = build(gap, gap.endT ?? model.nowT, true)
                    if (!built) continue
                    drafts.set(gap, built.draft)
                    episodes.set(built.draft.key, built.next)
                    out.push(built.draft)
                    // A silence that ended because the connection closed is not resolved yet; one that ended with data on its own connection is.
                    if (built.draft.status === 'open') unresolved.set(built.draft.key, { draft: built.draft, conn: gap.conn })
                    else unresolved.delete(built.draft.key)
                }
                // A cadence change the model recognised with this gap (three consecutive, consistent stalls): the stall stays on record, resolved, with
                // what it was, and a note says the stream's rhythm was inferred to have changed. Only for a stall this rule reported.
                for (const shift of model.delta.shifts ?? []) {
                    const last = shift.gaps.at(-1)!
                    const gap = model.delta.gaps.find((g) => g.clock === shift.clock && g.endSeq === last.endSeq && g.via === 'next')
                    const draft = gap && drafts.get(gap)
                    if (!gap || !draft) continue
                    const note = cadenceChanged(shift, gap, draft.key, model.baseline[shift.clock].snapshot(), ctx, cadences)
                    draft.facts = [...draft.facts, { text: `The cadence was then recognised as changed: three consecutive silences like this one agree with one another, so the stream's rhythm was taken to be about ${fmtMs(shift.medianMs)} from here on (inferred, see ${note.key}). This stall stays on record as history.`, evidence: [] }]
                    out.push(note)
                }
                // A later connection delivering an event is the recovery. The stall stays on record with everything it was (its duration, its
                // evidence, its count); it is only no longer open, so a recovered stream does not keep failing a gate.
                if (o.kind === 'event') {
                    for (const [key, u] of unresolved) {
                        if (o.conn <= u.conn) continue
                        out.push({ ...u.draft, status: 'resolved', facts: [...u.draft.facts, { text: `A later connection delivered an event at t=${fmtMs(o.t)}, so the stream recovered; the stall is kept as history.`, evidence: [ev(o.seq, o.t, 'a later connection delivered an event')] }] })
                        unresolved.delete(key)
                    }
                }
                return out
            },
            onTick(nowT, model) {
                const out: FindingDraft[] = []
                for (const gap of model.openGaps()) {
                    const built = build(gap, nowT, false)
                    if (built) out.push(built.draft)
                }
                return out
            },
            onEnd(endT, model) {
                const out: FindingDraft[] = []
                for (const gap of model.openGaps()) {
                    const built = build(gap, endT, true)
                    if (!built) continue
                    episodes.set(built.draft.key, built.next)
                    out.push(built.draft)
                }
                return out
            },
            coverage() {
                return {
                    evaluated: true,
                    notes: [
                        'Subtype (iii), a partial frame stuck in the parser, is not evaluated: the parser\'s pendingBytes is not recorded yet.',
                        'Tab visibility is not recorded, so hidden-tab suppression is not applied.',
                    ],
                }
            },
        }
    },
}
