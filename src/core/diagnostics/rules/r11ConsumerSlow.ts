import type { Evidence, Fact, FindingDraft } from '../finding'
import type { Rule, RuleContext } from '../rule'
import { RollingStats } from '../stats'
import type { StreamModel } from '../streamModel'
import { ev, fmtMs, plural } from './util'

/**
 * R11 consumer.slow: the page receives events on time and processes them late.
 *
 * Input is the page-domain `consumer` records (events received, queue depth, receive and process times, lag). The
 * engine's stream model does not track them, so this rule keeps its own state, fed by onObservation.
 *
 *  - consumer.slow            p95 lag above `consumerLagP95Ms` (after enough samples), or the queue grew by more than
 *                             `consumerQueueGrowth` inside `consumerWindowMs`;
 *  - consumer.queue-overflow  the queue reached `consumerQueueCap`: the app drops events past it, which is loss inside
 *                             the app and not on the network.
 *
 * "Receipt healthy, processing late" is only said when the transport side looks clean: byte gaps with no outlier and
 * no reconnect. Without transport records the network side is unknown and nothing is claimed about it.
 */

const MIN_SAMPLES = 20
const REFRESH_EVERY = 32

type Net = 'healthy' | 'unhealthy' | 'unknown'

export const consumerSlow: Rule = {
    id: 'consumer.slow',
    version: 1,
    title: 'Slow consumer',
    requires: ['consumer'],
    create({ thresholds: th }: RuleContext) {
        const lag = new RollingStats(256)
        // Monotonic window of queue depths: the front is the smallest depth inside the window.
        const win: Array<{ t: number; depth: number }> = []
        let head = 0
        let hot = false
        let everHot = false
        let sinceEmit = 0
        let first: { seq: number; t: number } | undefined
        let latest: { seq: number; t: number } | undefined
        let worstP95 = 0
        let worstLag = 0
        let lagFired = false
        let growthFired = false
        let worstGrowth = 0
        let peakDepth = 0
        let overflow: { seq: number; t: number; depth: number } | undefined
        let episodes = 0

        const network = (model: StreamModel): { state: Net; p95?: number; longest?: number } => {
            if (!model.seenKinds.has('chunk') || model.gaps.byte.count < 5) return { state: 'unknown' }
            const p95 = model.gaps.byte.p95() ?? 0
            const longest = model.gaps.byte.maxEver
            const clean = longest <= th.stallP95Factor * p95 + th.stallMinSilenceMs && model.reconnects.length === 0
            return { state: clean ? 'healthy' : 'unhealthy', p95, longest }
        }

        const slowDraft = (model: StreamModel, t: number, resolved: boolean): FindingDraft => {
            const net = network(model)
            const evidence: Evidence[] = [...(first ? [ev(first.seq, first.t, 'first sample over a limit')] : []), ...(latest ? [ev(latest.seq, latest.t, 'latest sample')] : [])]
            const facts: Fact[] = []
            if (lagFired) facts.push({ text: `The 95th percentile of the wait between an event reaching the page and being processed reached ${fmtMs(worstP95)} (limit ${fmtMs(th.consumerLagP95Ms)}); the longest single wait was ${fmtMs(worstLag)}, over ${plural(lag.count, 'sample')}.`, evidence })
            if (growthFired) facts.push({ text: `The queue of unprocessed events grew by ${worstGrowth} within ${fmtMs(th.consumerWindowMs)} (limit ${th.consumerQueueGrowth}); its peak was ${peakDepth}.`, evidence: lagFired ? [] : evidence })
            if (net.state === 'healthy') facts.push({ text: `Receipt was healthy: bytes arrived with a steady rhythm (p95 gap ${fmtMs(net.p95 ?? 0)}, longest ${fmtMs(net.longest ?? 0)}) and the connection did not drop.`, evidence: [] })
            else if (net.state === 'unhealthy') facts.push({ text: `The network side was not clean either: the longest gap between bytes was ${fmtMs(net.longest ?? 0)} (p95 ${fmtMs(net.p95 ?? 0)}), or the connection dropped.`, evidence: [] })
            const healthy = net.state === 'healthy'
            const waiting = lagFired ? `events wait up to ${fmtMs(worstP95)} (p95) between reaching the page and being processed` : `the queue of unprocessed events grew by ${worstGrowth}`
            return {
                key: 'consumer.slow',
                severity: 'warning',
                title: 'The page processes events late',
                summary: healthy
                    ? `Receipt healthy, processing late: ${waiting}.`
                    : `${waiting[0]!.toUpperCase()}${waiting.slice(1)}.`,
                facts,
                deductions: [{
                    statement: healthy
                        ? 'Likely: the page\'s own event handling (parsing, state updates or rendering) is slower than the rate events arrive; the network is not the cause.'
                        : 'Likely: the page cannot keep up with the arrival rate; the network may also contribute, and this check cannot separate the two.',
                    confidence: healthy ? 'medium' : 'low',
                    basis: evidence.map((e) => e.seq),
                    alternatives: ['The tab was in the background and its timers and rendering were throttled.', 'Another task blocked the main thread for a while.', ...(healthy ? [] : ['Events arrived late at the page for a network reason.'])],
                }],
                nextCheck: { description: 'Profile the event handler (the Performance panel), and batch updates or move heavy work off the handler.' },
                limits: [
                    'The worker-to-page hop is approximate: the receive time is stamped on the page, so time spent in the worker or in the message between them is not part of the wait.',
                    'Whether the tab was visible is not recorded, so background throttling is not ruled out.',
                    ...(net.state === 'unknown' ? ['No transport records back this capture, so whether receipt was healthy is not known.'] : []),
                ],
                status: resolved ? 'resolved' : 'open', firstSeenT: first?.t ?? t, lastSeenT: latest?.t ?? t, occurrences: episodes,
            }
        }

        const overflowDraft = (): FindingDraft => {
            const o = overflow!
            const evidence = [ev(o.seq, o.t, 'queue at its limit')]
            return {
                key: 'consumer.queue-overflow',
                severity: 'error',
                title: 'The app dropped events',
                summary: `The ingest queue reached its limit of ${th.consumerQueueCap} events; events past it are dropped by the app. This is loss inside the app, not on the network.`,
                facts: [{ text: `The queue held ${plural(o.depth, 'event')} at t=${fmtMs(o.t)}, at or above its limit of ${th.consumerQueueCap}.`, evidence }],
                deductions: [{ statement: 'Likely: events that arrived after the queue was full were discarded by the app, so the page missed events that the network delivered.', confidence: 'medium', basis: [o.seq], alternatives: ['The queue applies backpressure instead of dropping, and nothing was lost.'] }],
                nextCheck: { description: 'Check whether the stream\'s sequence numbers show gaps after this time (the sequence rules separate app drops from network loss).' },
                limits: [
                    'How many events were dropped is not recorded.',
                    'The worker-to-page hop is approximate, so the moment the limit was reached is too.',
                ],
                status: 'open', firstSeenT: o.t, lastSeenT: o.t, occurrences: 1,
            }
        }

        return {
            onObservation(o, model) {
                if (o.kind !== 'consumer' || o.domain === 'transport') return
                const out: FindingDraft[] = []
                lag.push(o.lagMs)
                latest = { seq: o.seq, t: o.t }
                worstLag = Math.max(worstLag, o.lagMs)
                peakDepth = Math.max(peakDepth, o.queueDepth)

                const at = o.processedT
                while (win.length > head && win[win.length - 1]!.depth >= o.queueDepth) win.pop()
                win.push({ t: at, depth: o.queueDepth })
                while (win[head]!.t < at - th.consumerWindowMs) head++
                if (head > 1024) { win.splice(0, head); head = 0 }
                const growth = o.queueDepth - win[head]!.depth
                const p95 = lag.count >= MIN_SAMPLES ? (lag.p95() ?? 0) : 0
                const lagHot = p95 > th.consumerLagP95Ms
                const growthHot = growth > th.consumerQueueGrowth
                const nowHot = lagHot || growthHot

                if (lagHot) { lagFired = true; worstP95 = Math.max(worstP95, p95) }
                if (growthHot) { growthFired = true; worstGrowth = Math.max(worstGrowth, growth) }
                if (nowHot) { everHot = true; first ??= { seq: o.seq, t: o.t } }

                if (nowHot !== hot || (nowHot && ++sinceEmit >= REFRESH_EVERY)) {
                    if (nowHot && !hot) episodes++
                    hot = nowHot
                    sinceEmit = 0
                    out.push(slowDraft(model, o.t, !nowHot))
                }

                if (!overflow && o.queueDepth >= th.consumerQueueCap) {
                    overflow = { seq: o.seq, t: o.t, depth: o.queueDepth }
                    out.push(overflowDraft())
                }
                return out
            },
            onEnd(endT, model) {
                const out: FindingDraft[] = []
                if (everHot) out.push(slowDraft(model, latest?.t ?? endT, !hot))
                return out
            },
        }
    },
}
