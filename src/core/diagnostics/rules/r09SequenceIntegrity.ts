import type { Evidence, FindingDraft } from '../finding'
import type { Rule, RuleContext } from '../rule'
import type { StreamModel } from '../streamModel'
import { SequenceTracker, type TrackerOutput } from '../sequenceTracker'
import { ev, plural } from './util'

/**
 * R09 seq.integrity: gaps, duplicates, regressions and late arrivals in the stream's numbering.
 *
 * Only under a DECLARED sequence contract (profile.sequence). Numbers that merely look sequential prove nothing: a
 * server may legitimately send 104 and then 111. Without a contract the rule says continuity cannot be verified, and at
 * most notes (in its coverage, not as a finding) that the ids look sequential and could be declared. A gap is confirmed after a reorder window, so a late
 * event that fills it is not reported as loss. Numbering is tracked per partition when the profile names one.
 * A jump on the first event of a new connection belongs to the resume rule (R08), not here.
 */

const MAX_PARTITIONS = 1000
const EXAMPLES = 5
const MAX_RANGES = 1000
const HINT_RUN = 10
const UNREADABLE_MIN = 3
const UNREADABLE_SHARE = 0.25

interface PartitionState {
    tracker: SequenceTracker
    conn: number
}

interface Agg {
    count: number
    firstT: number
    lastT: number
    examples: string[]
    evidence: Evidence[]
}

const empty = (): Agg => ({ count: 0, firstT: Infinity, lastT: 0, examples: [], evidence: [] })

function range(from: number, to: number): string { return from === to ? `${from}` : `${from}-${to}` }

export const sequenceIntegrity: Rule = {
    id: 'seq.integrity',
    version: 1,
    title: 'Sequence integrity',
    requires: ['events'],
    create({ thresholds: th, profile }: RuleContext) {
        const contract = profile.sequence && (profile.sequence.field || profile.sequence.useSseId) ? profile.sequence : undefined
        const semantics = profile.delivery ?? 'at_least_once'
        const partitions = new Map<string, PartitionState>()
        // Highest number a partition had when its current connection began: what a resume may legitimately replay.
        const replayCeiling = new Map<string, number | undefined>()
        let overflowed = false
        const unreadable = empty()
        let totalMissing = 0
        const gapRanges: Array<{ from: number; to: number }> = []
        const agg = { gap: empty(), duplicate: empty(), replay: empty(), conflict: empty(), regression: empty(), reorder: empty() }
        let run = 0
        let lastId: number | undefined
        let hinted = false
        let events = 0

        const add = (a: Agg, example: string, evidence: Evidence[], t: number): void => {
            a.count++
            a.firstT = Math.min(a.firstT, t)
            a.lastT = Math.max(a.lastT, t)
            if (a.examples.length < EXAMPLES) { a.examples.push(example); a.evidence.push(...evidence) }
        }

        const apply = (outputs: TrackerOutput[], partition: string): Array<keyof typeof agg> => {
            const changed: Array<keyof typeof agg> = []
            const label = partition ? ` in partition "${partition}"` : ''
            for (const o of outputs) {
                switch (o.kind) {
                    case 'gap': {
                        totalMissing += o.to - o.from + 1
                        if (gapRanges.length < MAX_RANGES) gapRanges.push({ from: o.from, to: o.to })
                        add(agg.gap, `${range(o.from, o.to)} (missing between #${o.before.seq} and #${o.after.seq})${label}`, [ev(o.before.seq, o.before.t, 'last number before the gap'), ev(o.after.seq, o.after.t, 'first number after the gap')], o.after.t)
                        changed.push('gap'); break
                    }
                    case 'duplicate': {
                        const a = o.conflict ? agg.conflict : o.replay ? agg.replay : agg.duplicate
                        add(a, `${o.value}${label}`, [ev(o.first.seq, o.first.t, 'first delivery'), ev(o.again.seq, o.again.t, 'delivered again')], o.again.t)
                        changed.push(o.conflict ? 'conflict' : o.replay ? 'replay' : 'duplicate'); break
                    }
                    case 'regression':
                        add(agg.regression, `${o.from} then ${o.to}${label}`, [ev(o.before.seq, o.before.t, 'highest number so far'), ev(o.after.seq, o.after.t, 'lower number')], o.after.t)
                        changed.push('regression'); break
                    case 'reorder':
                        add(agg.reorder, `${o.value}${label}`, [ev(o.opened.seq, o.opened.t, 'a later number arrived first'), ev(o.late.seq, o.late.t, 'the number arrived late')], o.late.t)
                        changed.push('reorder'); break
                    case 'boundary-gap': break // the resume rule's
                }
            }
            return changed
        }

        const finding = (kind: keyof typeof agg, endT: number, final: boolean): FindingDraft | undefined => {
            const a = agg[kind]
            if (a.count === 0) return undefined
            const examples = a.examples.join('; ')
            const more = a.count > a.examples.length ? ` (first ${a.examples.length} shown)` : ''
            const base = { firstSeenT: a.firstT, lastSeenT: Math.max(a.lastT, endT), occurrences: a.count, status: 'open' as const }
            const factText = (text: string) => [{ text, evidence: a.evidence }]
            switch (kind) {
                case 'gap': {
                    const text = `${plural(totalMissing, 'number')} never arrived in ${plural(a.count, 'gap')}: ${examples}${more}.`
                    return {
                        key: 'seq.integrity:gap', severity: 'error', title: 'Events missing from the sequence', summary: text,
                        data: { ranges: gapRanges.slice(), truncated: a.count > gapRanges.length },
                        facts: [...factText(text), { text: `The stream declares its numbering as ${contract?.policy} (${contract?.useSseId ? 'the SSE id' : contract?.field}), and a number was still missing after ${th.reorderWindowEvents} more events or ${th.reorderWindowMs} ms.`, evidence: [] }],
                        deductions: [{ statement: 'Likely: events were lost between the producer and this client, by the producer, an intermediary, or a resume that skipped them.', confidence: 'medium', basis: a.evidence.map((e) => e.seq), alternatives: ['The producer skips numbers on purpose (declare policy "monotonic").', 'Another partition uses the same numbers (declare partitionBy).', 'The events were filtered out upstream for this client.'] }],
                        nextCheck: { description: 'Compare with the producer\'s own log for the missing numbers, then check whether the reconnect resumed from the right id.' },
                        limits: ['Only a declared sequence contract makes a missing number a loss; the client cannot see events that never reached it.', ...(final ? ['The capture ended while some gaps were still within the reorder window.'] : [])],
                        ...base,
                    }
                }
                case 'duplicate': {
                    const severity = semantics === 'at_least_once' ? 'warning' : 'error'
                    const text = `${plural(a.count, 'number')} delivered more than once on one connection: ${examples}${more}.`
                    return {
                        key: 'seq.integrity:duplicate', severity, title: 'Duplicate events', summary: text, facts: factText(text),
                        deductions: [{ statement: 'Likely: the producer or an intermediary sent the same event twice without a reconnect in between.', confidence: 'low', basis: a.evidence.map((e) => e.seq), alternatives: ['A retry at the producer after an unconfirmed write.', 'Two producers sharing one numbering.'] }],
                        limits: ['Identical numbers are duplicates only if they mean the same event; the payload hash decides whether it is a redelivery or a conflict.'],
                        ...base,
                    }
                }
                case 'replay': {
                    const text = `${plural(a.count, 'number')} came again after a reconnect: ${examples}${more}.`
                    const severity = semantics === 'at_least_once' ? 'info' : 'warning'
                    return {
                        key: 'seq.integrity:replay', severity, title: 'Events replayed after reconnect', summary: text, facts: factText(text),
                        deductions: [], limits: [semantics === 'at_least_once' ? 'Expected under at-least-once delivery: the server resumed a little before the cursor.' : `The stream is declared ${semantics.replace(/_/g, ' ')}, so replay is not expected.`],
                        ...base,
                    }
                }
                case 'conflict': {
                    const text = `${plural(a.count, 'number')} came again with a different payload: ${examples}${more}.`
                    return {
                        key: 'seq.integrity:conflict', severity: 'error', title: 'Same sequence number, different data', summary: text, facts: factText(text),
                        deductions: [{ statement: 'Likely: two different events share one number (a restarted producer, or numbering shared between producers).', confidence: 'medium', basis: a.evidence.map((e) => e.seq), alternatives: ['The payload carries a timestamp that changes on redelivery.'] }],
                        limits: ['The payload hashes are salted per capture; they show equality, not what differs.'],
                        ...base,
                    }
                }
                case 'regression': {
                    const text = `The numbering went backwards ${plural(a.count, 'time')}: ${examples}${more}.`
                    return {
                        key: 'seq.integrity:regression', severity: 'warning', title: 'Sequence went backwards', summary: text, facts: factText(text),
                        deductions: [{ statement: 'Likely: the producer restarted or reset its counter.', confidence: 'low', basis: a.evidence.map((e) => e.seq), alternatives: ['A different partition uses the same field.', 'Events from an older replica.'] }],
                        limits: ['After a reset the rule starts counting again from the new number.'],
                        ...base,
                    }
                }
                case 'reorder': {
                    const text = `${plural(a.count, 'number')} arrived after a later one: ${examples}${more}.`
                    return {
                        key: 'seq.integrity:reorder', severity: 'info', title: 'Events arrived out of order', summary: text, facts: factText(text),
                        deductions: [], limits: [`Numbers that arrived within ${th.reorderWindowEvents} events or ${th.reorderWindowMs} ms of the gap were not counted as missing.`],
                        ...base,
                    }
                }
            }
        }

        const stateFor = (key: string): PartitionState | undefined => {
            let st = partitions.get(key)
            if (!st && partitions.size >= MAX_PARTITIONS) { overflowed = true; return undefined }
            if (!st) {
                st = { tracker: new SequenceTracker({ policy: contract?.policy ?? 'monotonic', reorderWindowEvents: th.reorderWindowEvents, reorderWindowMs: th.reorderWindowMs, window: th.sequenceWindow }), conn: -1 }
                partitions.set(key, st)
            }
            return st
        }

        const unreadableDraft = (endT: number): FindingDraft => ({
            key: 'seq.integrity:unreadable', severity: 'warning', title: 'Sequence value not readable', summary: `${plural(unreadable.count, 'event')} had no readable sequence number.`,
            facts: [{ text: `${plural(unreadable.count, 'event')} did not carry a number at the declared place (${contract?.useSseId ? 'the SSE id' : contract?.field}).`, evidence: unreadable.evidence }],
            deductions: [{ statement: 'Likely: the declared field or path does not match the payload of those events.', confidence: 'medium', basis: unreadable.evidence.map((e) => e.seq), alternatives: ['Those events are a different kind (heartbeats, errors) that carry no number.'] }],
            nextCheck: { description: 'Check the sequence field in the stream profile against a real payload.' },
            limits: ['Payloads larger than the probe limit, or not JSON, cannot be read for a sequence field.'],
            status: 'open', firstSeenT: unreadable.firstT, lastSeenT: Math.max(unreadable.lastT, endT), occurrences: unreadable.count,
        })

        return {
            onObservation(o) {
                if (o.kind !== 'event') return
                events++
                if (!contract) {
                    const id = /^\d{1,15}$/.test(o.sseId) ? Number(o.sseId) : undefined
                    run = id !== undefined && lastId !== undefined && id === lastId + 1 ? run + 1 : 1
                    lastId = id
                    if (run >= HINT_RUN) hinted = true
                    return
                }
                const raw = o.extracted?.seq
                const value = typeof raw === 'number' ? raw : typeof raw === 'string' && /^-?\d{1,15}$/.test(raw) ? Number(raw) : undefined
                if (value === undefined) {
                    add(unreadable, `#${o.seq}`, [ev(o.seq, o.t)], o.t)
                    // A few events without a number are normal (a closing event, a heartbeat event). Only a real share of them means the declaration does not fit.
                    return unreadable.count >= UNREADABLE_MIN && unreadable.count / events >= UNREADABLE_SHARE ? [unreadableDraft(o.t)] : undefined
                }
                const partition = o.extracted?.partition ?? ''
                const st = stateFor(partition)
                if (!st) return
                const boundary = st.conn !== -1 && o.conn !== st.conn
                if (st.conn === -1 || boundary) { st.conn = o.conn; replayCeiling.set(partition, st.tracker.highest) }
                const ceiling = replayCeiling.get(partition)
                const replay = o.conn > 0 && ceiling !== undefined && value <= ceiling
                const changed = apply(st.tracker.accept(value, o.dataHash ?? '', { seq: o.seq, t: o.t }, { boundary, replay }), partition)
                return [...new Set(changed)].map((k) => finding(k, o.t, false)).filter((d): d is FindingDraft => d !== undefined)
            },
            /**
             * A gap is normally confirmed by the events that follow it. When the stream goes quiet right after one, time alone
             * confirms it: show it provisionally. The state is put back afterwards, so ticks change nothing.
             */
            onTick(nowT) {
                if (!contract) return
                const due: Array<{ partition: string; output: TrackerOutput }> = []
                for (const [partition, st] of partitions) for (const output of st.tracker.dueGaps(nowT)) due.push({ partition, output })
                if (due.length === 0) return
                const saved = { ...agg.gap, examples: [...agg.gap.examples], evidence: [...agg.gap.evidence] }
                const savedMissing = totalMissing
                const savedRanges = gapRanges.length
                for (const { partition, output } of due) apply([output], partition)
                const draft = finding('gap', nowT, false)
                agg.gap = saved
                totalMissing = savedMissing
                gapRanges.length = savedRanges
                return draft ? [draft] : undefined
            },
            onEnd(endT) {
                if (!contract) return
                const drafts: FindingDraft[] = []
                const changed = new Set<keyof typeof agg>()
                for (const [partition, st] of partitions) for (const k of apply(st.tracker.finish(), partition)) changed.add(k)
                for (const k of changed) { const d = finding(k, endT, true); if (d) drafts.push(d) }
                if (overflowed) drafts.push({
                    key: 'seq.integrity:partitions', severity: 'info', title: 'Too many partitions to track', summary: `Only the first ${MAX_PARTITIONS} partitions were tracked.`,
                    facts: [{ text: `More than ${MAX_PARTITIONS} distinct partition values were seen.`, evidence: [] }], deductions: [], limits: ['Events in the remaining partitions were not checked.'],
                    status: 'open', firstSeenT: endT, lastSeenT: endT, occurrences: 1,
                })
                return drafts
            },
            coverage(_model: StreamModel) {
                if (!contract) {
                    // A hint, not a finding: a healthy stream must not carry findings, and the ids may be sequential by accident.
                    const hint = hinted ? [' The event ids count up by one; declare them as the sequence ({ "sequence": { "useSseId": true, "policy": "consecutive" } }) to have gaps and duplicates checked.'] : []
                    return { evaluated: false, notes: [`Continuity is not verified: no sequence contract is declared for this stream, and ids alone prove nothing.${hint.join('')}`] }
                }
                if (events > 0 && unreadable.count === events) return { evaluated: false, notes: ['None of the events carried a readable sequence number at the declared place.'] }
                return { evaluated: true, notes: unreadable.count > 0 ? [`${plural(unreadable.count, 'event')} had no readable sequence number and were skipped.`] : [] }
            },
        }
    },
}
