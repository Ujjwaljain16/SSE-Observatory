import type { FindingDraft } from '../finding'
import type { Rule, RuleContext } from '../rule'
import type { HeartbeatSource, Mark, StreamModel } from '../streamModel'
import { ev, fmtMs, plural } from './util'

/**
 * R10 heartbeat.recognition: comments are classified by who sent them (the proxy's tagged comments vs the origin's)
 * and their rhythm is measured (median, p95, jitter live on the model). A heartbeat is "late" when its interval is
 * more than 2.5x the usual one; R05 uses the origin cadence to set its stall threshold. Absence of heartbeats is
 * only ever an info note. Heartbeats stay in the evidence; nothing is removed from the capture.
 */

interface Late { count: number; firstSeenT: number }

const LABEL: Record<HeartbeatSource, string> = { upstream: 'origin', proxy: 'proxy' }

export const heartbeat: Rule = {
    id: 'heartbeat.recognition',
    version: 1,
    title: 'Heartbeat rhythm',
    requires: ['comments'],
    create({ thresholds: th }: RuleContext) {
        const late = new Map<HeartbeatSource, Late>()

        const draft = (source: HeartbeatSource, intervalMs: number, medianMs: number, intervals: number, prev: Mark, cur: Mark | undefined, endT: number, final: boolean): { draft: FindingDraft; next: Late } => {
            const prior = late.get(source)
            const next: Late = { count: (prior?.count ?? 0) + 1, firstSeenT: prior?.firstSeenT ?? prev.t + th.heartbeatLateFactor * medianMs }
            const evidence = [ev(prev.seq, prev.t, 'previous heartbeat'), ...(cur ? [ev(cur.seq, cur.t, 'late heartbeat')] : [])]
            const label = LABEL[source]
            const text = cur
                ? `A ${label} heartbeat arrived ${fmtMs(intervalMs)} after the previous one; the usual interval is ${fmtMs(medianMs)} (median of ${plural(intervals, 'interval')}).`
                : `No ${label} heartbeat for ${fmtMs(intervalMs)} so far; the usual interval is ${fmtMs(medianMs)} (median of ${plural(intervals, 'interval')}).`
            return {
                next,
                draft: {
                    key: `heartbeat.late:${label}`, severity: 'warning', title: `${label === 'origin' ? 'Origin' : 'Proxy'} heartbeat late`,
                    summary: text,
                    facts: [{ text, evidence }, { text: `A heartbeat is late beyond ${th.heartbeatLateFactor} times the usual interval (${fmtMs(th.heartbeatLateFactor * medianMs)}).`, evidence: [] }],
                    deductions: [{ statement: 'Likely: delivery paused for that interval (a stall, buffering or throttling); the producer\'s own timer may also have been delayed.', confidence: 'low', basis: evidence.map((e) => e.seq), alternatives: ['The producer was blocked or garbage collecting.', 'Browser throttling of a background tab.', 'An intermediary released bytes in a burst.'] }],
                    limits: ['Heartbeats are recognised as comments; a producer that sends data-only heartbeats is not recognised without a stream profile.'],
                    status: final && cur ? 'resolved' : 'open',
                    firstSeenT: next.firstSeenT, lastSeenT: endT, occurrences: next.count,
                },
            }
        }

        const pending = (nowT: number, model: StreamModel, keep: boolean): FindingDraft[] => {
            const out: FindingDraft[] = []
            for (const source of ['upstream', 'proxy'] as const) {
                const gap = model.openHeartbeatGap(source)
                if (!gap || gap.median === undefined || gap.intervals < th.heartbeatMinIntervals) continue
                const dur = nowT - gap.prev.t
                if (dur <= th.heartbeatLateFactor * gap.median) continue
                const built = draft(source, dur, gap.median, gap.intervals, gap.prev, undefined, nowT, false)
                if (keep) late.set(source, built.next)
                out.push(built.draft)
            }
            return out
        }

        return {
            onObservation(_o, model) {
                const h = model.delta.heartbeat
                if (!h || h.medianBefore === undefined || h.intervalsBefore < th.heartbeatMinIntervals) return
                if (h.intervalMs <= th.heartbeatLateFactor * h.medianBefore) return
                const built = draft(h.source, h.intervalMs, h.medianBefore, h.intervalsBefore, h.prev, h.cur, h.cur.t, true)
                late.set(h.source, built.next)
                return [built.draft]
            },
            onTick(nowT, model) { return pending(nowT, model, false) },
            onEnd(endT, model) {
                const out = pending(endT, model, true)
                const none = model.heartbeats.upstream.count === 0 && model.heartbeats.proxy.count === 0
                const longest = model.gaps.byte.maxEver
                if (none && longest >= th.stallNoCadenceMs) {
                    out.push({
                        key: 'heartbeat.absent', severity: 'info', title: 'No heartbeats seen',
                        summary: `No heartbeat comments were seen and the longest silence between bytes was ${fmtMs(longest)}.`,
                        facts: [{ text: `No comment records were received; the longest gap between bytes was ${fmtMs(longest)}.`, evidence: [] }],
                        deductions: [{ statement: 'Likely: without a heartbeat, a long quiet period cannot be told apart from a stalled connection.', confidence: 'low', basis: [], alternatives: ['The stream legitimately has long idle periods.'] }],
                        limits: ['Absence is informational only: many healthy streams send no heartbeat.'],
                        status: 'open', firstSeenT: endT, lastSeenT: endT, occurrences: 1,
                    })
                }
                return out
            },
        }
    },
}
