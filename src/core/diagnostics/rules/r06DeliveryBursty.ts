import type { Evidence, FindingDraft } from '../finding'
import type { Rule, RuleContext } from '../rule'
import { RollingStats } from '../stats'
import { cv, median, pct } from './numeric'
import { ev, fmtMs, plural } from './util'

/**
 * R06 delivery.bursty: events reach the client in tight clusters with quiet time between, instead of one by one.
 *
 * A cluster is a run of events each at most a few milliseconds after the one before (they were written together, or
 * released together by a buffer). A burst is a cluster of at least `burstEventsPerWindow` events. The rule fires when
 * at least `burstMinEvents` events came in bursts, at least three bursts follow a quiet time of `burstMinGapMs` or
 * more, and the bursts repeat at a roughly even period (or fill a typical buffer size).
 *
 * A fast steady stream must stay silent: five thousand tiny events a second form one endless cluster with no quiet
 * time, and a producer that really sends a batch of hundreds every second has a nominal gap between events far below
 * `burstMinNominalGapMs`. The nominal gap is the median spacing of producer timestamps inside clusters when the
 * profile extracts them, otherwise the burst period divided by the burst size.
 *
 * This is a hypothesis only. Medium confidence needs producer timestamps that are evenly spaced while arrival is
 * clustered, which is the one thing that separates "the producer batches" from "something held the bytes".
 */

interface Cluster {
    conn: number
    startT: number
    lastT: number
    firstSeq: number
    lastSeq: number
    count: number
    /** Time since the previous event on the same connection; undefined for a connection's first event. */
    gapBefore: number | undefined
    /** Largest chunk that carried one of its events. */
    topChunk: number
}

const JOIN_CAP_MS = 20
const MIN_QUALIFIED = 3
const MAX_PERIOD_CV = 0.35
const BUFFER_SIZES = [4096, 8192, 16384, 65536]
const KEEP = 64
/** Producer spacing is "even" when the typical deviation is under this share of the median spacing. */
const EVEN_SPACING = 0.2

interface Assessment {
    events: number
    bursts: number
    qualified: number
    medianSize: number
    medianSpanMs: number
    medianQuietMs: number
    periodMs: number
    periodCv: number | undefined
    nominalMs: number
    producerMs: number | undefined
    evenAtProducer: boolean
    sizeHint: number | undefined
    shown: Cluster[]
}

export const deliveryBursty: Rule = {
    id: 'delivery.bursty',
    version: 1,
    title: 'Bursty delivery',
    requires: ['events', 'chunks'],
    create({ thresholds: th, profile }: RuleContext) {
        const join = Math.min(JOIN_CAP_MS, th.burstMinGapMs / 4)
        let cur: Cluster | undefined
        let prevEvent: { conn: number; t: number; ts: number | undefined } | undefined
        let lastChunk: number | undefined
        const bursts: Cluster[] = []
        let totalBursts = 0
        let totalEvents = 0
        const producerGaps = new RollingStats(512)
        let firedT: number | undefined

        const assess = (open: Cluster | undefined): Assessment | undefined => {
            const list = open && open.count >= th.burstEventsPerWindow ? [...bursts, open] : bursts
            const events = totalEvents + (open && open.count >= th.burstEventsPerWindow ? open.count : 0)
            if (events < th.burstMinEvents) return undefined
            const qualifiedList = list.filter((c) => c.gapBefore !== undefined && c.gapBefore >= th.burstMinGapMs)
            if (qualifiedList.length < MIN_QUALIFIED) return undefined

            const periods: number[] = []
            for (let i = 1; i < list.length; i++) {
                const a = list[i - 1]!
                const b = list[i]!
                if (a.conn === b.conn && b.gapBefore !== undefined && b.gapBefore >= th.burstMinGapMs) periods.push(b.startT - a.startT)
            }
            const periodMs = median(periods) ?? 0
            const periodCv = cv(periods)
            const regular = periodCv !== undefined && periodCv <= MAX_PERIOD_CV

            const near = (bytes: number, size: number) => bytes <= size && bytes >= size * 0.95
            let sizeHint: number | undefined
            for (const size of BUFFER_SIZES) {
                if (list.filter((c) => near(c.topChunk, size)).length * 2 >= list.length) { sizeHint = size; break }
            }
            if (!regular && sizeHint === undefined) return undefined

            const medianSize = median(list.map((c) => c.count)) ?? 0
            const producerMedian = producerGaps.count >= 5 ? producerGaps.median() : undefined
            const producerMs = producerMedian !== undefined && producerMedian > 0 ? producerMedian : undefined
            const nominalMs = producerMs ?? (medianSize > 0 ? periodMs / medianSize : 0)
            if (nominalMs < th.burstMinNominalGapMs) return undefined

            const jitter = producerGaps.jitter()
            const evenAtProducer = producerMs !== undefined && jitter !== undefined && jitter / producerMs <= EVEN_SPACING
            return {
                events, bursts: totalBursts + (open && open.count >= th.burstEventsPerWindow ? 1 : 0), qualified: qualifiedList.length, medianSize,
                medianSpanMs: median(list.map((c) => c.lastT - c.startT)) ?? 0,
                medianQuietMs: median(qualifiedList.map((c) => c.gapBefore ?? 0)) ?? 0,
                periodMs, periodCv, nominalMs, producerMs, evenAtProducer, sizeHint,
                shown: list.slice(-3),
            }
        }

        const draft = (a: Assessment, nowT: number, firstT: number): FindingDraft => {
            const evidence: Evidence[] = a.shown.flatMap((c) => [ev(c.firstSeq, c.startT, 'burst start'), ev(c.lastSeq, c.lastT, 'burst end')])
            const facts = [
                { text: `${plural(a.events, 'event')} arrived in ${plural(a.bursts, 'tight cluster')} of at least ${th.burstEventsPerWindow} events (typically ${a.medianSize}), each delivered within ${fmtMs(a.medianSpanMs)}.`, evidence },
                { text: `The clusters follow quiet times of about ${fmtMs(a.medianQuietMs)} and start about ${fmtMs(a.periodMs)} apart${a.periodCv !== undefined ? ` (period varies by ${pct(a.periodCv)})` : ''}.`, evidence: [] },
            ]
            if (a.producerMs !== undefined) {
                facts.push({ text: `The producer timestamps inside clusters are ${a.evenAtProducer ? 'evenly' : 'unevenly'} spaced, about ${fmtMs(a.producerMs)} apart${a.evenAtProducer ? ', while arrival is clustered' : ''}.`, evidence: [] })
            } else {
                facts.push({ text: `Spacing at the producer is not known (no timestamp is extracted); spreading each cluster over its period gives about ${fmtMs(a.nominalMs)} per event.`, evidence: [] })
            }
            if (a.sizeHint !== undefined) facts.push({ text: `The largest chunk in at least half of the clusters is just under ${a.sizeHint} bytes, a common buffer size.`, evidence: [] })
            const medium = a.evenAtProducer
            return {
                key: 'delivery.bursty', severity: 'warning', title: 'Events arrive in bursts',
                summary: `Events arrive in clusters of about ${a.medianSize}, about ${fmtMs(a.periodMs)} apart, instead of one at a time.`,
                facts,
                deductions: [{
                    statement: 'Likely: response buffering (something holds the bytes and releases them in lumps).',
                    confidence: medium ? 'medium' : 'low',
                    basis: evidence.map((e) => e.seq),
                    alternatives: [
                        'The producer itself collects events and sends them in batches.',
                        'A proxy, CDN or compression layer buffers the response.',
                        'The network path delivers segments in groups (congestion, a radio link waking up).',
                        ...(medium ? [] : ['The producer\'s own timing is not known, so even production behind a buffer cannot be told from batching.']),
                    ],
                }],
                nextCheck: { description: 'Request the stream with curl, bypassing proxies where you can, and compare when events arrive; check the buffering headers and proxy settings in between.', command: 'curl -N -H "Accept: text/event-stream" "$URL"' },
                limits: [
                    'A browser capture sees the bytes after every hop, so it cannot name the layer that held them (application server, proxy, CDN or network).',
                    ...(a.producerMs === undefined ? ['Without producer timestamps (a timestamp field in the stream profile) batching at the producer cannot be told from buffering.'] : []),
                ],
                status: 'open', firstSeenT: firstT, lastSeenT: Math.max(nowT, a.shown[a.shown.length - 1]?.lastT ?? nowT), occurrences: a.bursts,
            }
        }

        const closeCurrent = (): FindingDraft[] => {
            const c = cur
            cur = undefined
            if (!c) return []
            if (c.count >= th.burstEventsPerWindow) {
                bursts.push(c)
                if (bursts.length > KEEP) bursts.shift()
                totalBursts++
                totalEvents += c.count
            }
            const a = assess(undefined)
            if (!a) return []
            firedT ??= c.lastT
            return [draft(a, c.lastT, firedT)]
        }

        return {
            onObservation(o) {
                if (o.kind === 'clock.discontinuity') {
                    prevEvent = undefined
                    return closeCurrent()
                }
                if (o.kind === 'chunk') { lastChunk = o.bytes; return }
                if (o.kind !== 'event') return
                const ts = o.extracted?.ts
                const sameConn = prevEvent !== undefined && prevEvent.conn === o.conn
                const gap = sameConn && prevEvent ? o.t - prevEvent.t : undefined
                let out: FindingDraft[] = []
                if (cur && cur.conn === o.conn && gap !== undefined && gap <= join) {
                    cur.count++
                    cur.lastT = o.t
                    cur.lastSeq = o.seq
                    if (prevEvent?.ts !== undefined && ts !== undefined && ts > prevEvent.ts) producerGaps.push(ts - prevEvent.ts)
                } else {
                    out = closeCurrent()
                    cur = { conn: o.conn, startT: o.t, lastT: o.t, firstSeq: o.seq, lastSeq: o.seq, count: 1, gapBefore: gap, topChunk: 0 }
                }
                if (lastChunk !== undefined) cur.topChunk = Math.max(cur.topChunk, lastChunk)
                prevEvent = { conn: o.conn, t: o.t, ts }
                return out
            },
            onTick(nowT) {
                if (!cur || cur.count < th.burstEventsPerWindow) return
                const a = assess(cur)
                return a ? [draft(a, nowT, firedT ?? cur.startT)] : undefined
            },
            onEnd() { return closeCurrent() },
            coverage() {
                return {
                    evaluated: true,
                    notes: profile.timestampField === undefined
                        ? ['No producer timestamp field is configured, so the spacing at the producer is estimated from the burst period; confidence stays low.']
                        : [],
                }
            },
        }
    },
}
