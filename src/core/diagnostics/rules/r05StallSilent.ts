import { maxSeverity, type Deduction, type Evidence, type Fact, type FindingDraft, type Severity } from '../finding'
import type { Rule, RuleContext } from '../rule'
import type { GapInfo } from '../streamModel'
import { stallLimit } from '../stallLimit'
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

export const stallSilent: Rule = {
    id: RULE_ID,
    version: 1,
    title: 'Silent stream',
    requires: ['phases', 'chunks'],
    create(ctx) {
        const episodes = new Map<string, Episodes>()
        /** Stalls that ended with their connection closing, as last reported (open), and the connection they were on. */
        const unresolved = new Map<string, { draft: FindingDraft; conn: number }>()

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
                for (const gap of model.delta.gaps) {
                    const built = build(gap, gap.endT ?? model.nowT, true)
                    if (!built) continue
                    episodes.set(built.draft.key, built.next)
                    out.push(built.draft)
                    // A silence that ended because the connection closed is not resolved yet; one that ended with data on its own connection is.
                    if (built.draft.status === 'open') unresolved.set(built.draft.key, { draft: built.draft, conn: gap.conn })
                    else unresolved.delete(built.draft.key)
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
