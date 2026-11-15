import type { Deduction, Evidence, Fact, FindingDraft, Severity } from '../finding'
import type { Rule, RuleContext } from '../rule'
import type { StreamModel } from '../streamModel'
import { parseProxyComment } from '../../proxyTags'
import { cv, mean, median, pct } from './numeric'
import { ev, fmtMs, plural } from './util'

/**
 * R07 reconnect.loop and reconnect.duration-pattern: the client keeps coming back.
 *
 * Loop: `loopMinConnections` connections inside `loopWindowMs`, or `loopNoEventReconnects` reconnects in a row with
 * no event in between. It is an error when nothing was delivered at all (the server refuses or drops every try), a
 * warning when the stream makes progress between drops.
 *
 * Duration pattern: `durationMinLifetimes` or more dropped connections whose lifetimes agree (coefficient of
 * variation under `durationMaxCv`). A fixed lifetime points at a cap or an idle timeout. If bytes were still arriving
 * right up to the drop it reads as a maximum-duration cap; if the connection had been silent it reads as an idle
 * timeout. A `: sse-proxy cap duration=` comment right before the close is the proxy saying it did it: a fact.
 *
 * State only changes in onObservation; the model is read for per-connection facts, never written.
 */

interface Lifetime {
    conn: number
    openT: number
    endT: number
    endSeq: number
    ms: number
    /** Time from the last byte to the close. */
    idleMs: number | undefined
    /** Bytes were still flowing at the drop; undefined when the stream has no rhythm to compare with. */
    alive: boolean | undefined
    cap: { durationMs: number; seq: number; t: number } | undefined
}

interface Loop { count: number; first: { conn: number; t: number; seq: number }; last: { conn: number; t: number; seq: number }; connConns: number[] }

const KEEP = 64
const KEEP_CONNECTS = 256

export const reconnectLoop: Rule = {
    id: 'reconnect.loop',
    version: 1,
    title: 'Reconnect loop and fixed connection lifetime',
    requires: ['phases', 'reconnects'],
    create({ thresholds: th }: RuleContext) {
        const connects: Array<{ conn: number; t: number; seq: number }> = []
        const lifetimes: Lifetime[] = []
        const counted = new Set<number>()
        const pendingCap = new Map<number, { durationMs: number; seq: number; t: number }>()
        let best: Loop | undefined
        let run = 0
        let maxRun = 0
        let runStartSeq = -1
        let runSeq = -1
        let loopFirstT: number | undefined
        let loopCount = 0
        let patternFirstT: number | undefined
        let patternCount = 0

        const loopFired = (): boolean => (best !== undefined && best.count >= th.loopMinConnections) || maxRun >= th.loopNoEventReconnects

        const buildLoop = (model: StreamModel, t: number): FindingDraft => {
            const facts: Fact[] = []
            let events = 0
            let evidence: Evidence[] = []
            if (best && best.count >= th.loopMinConnections) {
                events = best.connConns.reduce((sum, c) => sum + (model.conn(c)?.events ?? 0), 0)
                evidence = connects.filter((c) => best !== undefined && best.connConns.includes(c.conn)).slice(0, 5).map((c) => ev(c.seq, c.t, `connection ${c.conn}`))
                facts.push({ text: `${plural(best.count, 'connection')} were opened within ${fmtMs(best.last.t - best.first.t)} (connections ${best.first.conn} to ${best.last.conn}); the limit is ${th.loopMinConnections} within ${fmtMs(th.loopWindowMs)}.`, evidence })
                facts.push({ text: events === 0 ? 'No event was delivered on any of them.' : `${plural(events, 'event')} were delivered across them, so the stream made progress between drops.`, evidence: [] })
            }
            if (maxRun >= th.loopNoEventReconnects) {
                facts.push({ text: `${plural(maxRun, 'reconnect')} happened in a row without a single event in between.`, evidence: [ev(runStartSeq, model.reconnects.find((r) => r.seq === runStartSeq)?.t ?? t, 'first reconnect of the run'), ...(runSeq !== runStartSeq ? [ev(runSeq, model.reconnects.find((r) => r.seq === runSeq)?.t ?? t, 'latest')] : [])] })
            }
            const scope = best && best.count >= th.loopMinConnections ? model.reconnects.filter((r) => best !== undefined && best.connConns.includes(r.conn)) : model.reconnects.slice(-maxRun)
            const reasons = [...new Set(scope.map((r) => (r.status !== undefined ? `HTTP ${r.status}` : r.reason)))].slice(0, 3)
            if (reasons.length > 0) facts.push({ text: `Reconnect reasons: ${reasons.join('; ')}.`, evidence: [] })
            const delays = scope.map((r) => r.delayMs)
            const typical = median(delays)
            if (typical !== undefined) facts.push({ text: `The client waited about ${fmtMs(typical)} between attempts.`, evidence: [] })

            const noProgress = (best && best.count >= th.loopMinConnections && events === 0) || maxRun >= th.loopNoEventReconnects
            const severity: Severity = noProgress ? 'error' : 'warning'
            const deduction: Deduction = noProgress
                ? { statement: 'Likely: the server refuses or drops every attempt before sending an event (an error status, an authentication failure, or a crashing handler), and the client keeps retrying.', confidence: 'low', basis: evidence.map((e) => e.seq), alternatives: ['A real outage, with the client backing off as designed.', 'The stream requires something the client does not send (a token, a header).'] }
                : { statement: 'Likely: something cuts the connection repeatedly (a server, proxy or load-balancer limit, or restarts) and the client resumes each time.', confidence: 'low', basis: evidence.map((e) => e.seq), alternatives: ['The server closes deliberately after a batch of events.', 'The page code or a network change makes the client reconnect.'] }
            return {
                key: 'reconnect.loop', severity, title: noProgress ? 'Reconnecting without getting any data' : 'Connection keeps dropping and reconnecting',
                summary: noProgress ? 'The client keeps reconnecting and no event arrives.' : `${plural(best?.count ?? 0, 'connection')} within ${fmtMs(th.loopWindowMs)}: the stream keeps dropping.`,
                facts, deductions: [deduction],
                nextCheck: { description: 'Request the stream directly with curl and watch how long it stays open and what it sends before it closes.', command: 'curl -N -i -H "Accept: text/event-stream" "$URL"' },
                limits: ['Only connections the recorder saw are counted; earlier ones are not known.', 'A burst of retries during a real outage looks the same; the reconnect reasons tell them apart.'],
                status: 'open', firstSeenT: loopFirstT ?? t, lastSeenT: t, occurrences: loopCount,
            }
        }

        const buildPattern = (t: number): FindingDraft | undefined => {
            if (lifetimes.length < th.durationMinLifetimes) return undefined
            let pattern: Lifetime[] | undefined
            for (let start = 0; start <= lifetimes.length - th.durationMinLifetimes; start++) {
                const slice = lifetimes.slice(start)
                const spread = cv(slice.map((l) => l.ms))
                if (spread !== undefined && spread < th.durationMaxCv && (mean(slice.map((l) => l.ms)) ?? 0) >= 1) { pattern = slice; break }
            }
            if (!pattern) return undefined

            const ms = pattern.map((l) => l.ms)
            const avg = mean(ms) ?? 0
            const spread = cv(ms) ?? 0
            const evidence = pattern.slice(-5).map((l) => ev(l.endSeq, l.endT, `connection ${l.conn} ended after ${fmtMs(l.ms)}`))
            const facts: Fact[] = [{ text: `${pattern.length} dropped connections lasted ${fmtMs(avg)} each (between ${fmtMs(Math.min(...ms))} and ${fmtMs(Math.max(...ms))}; variation ${pct(spread)}, the limit is ${pct(th.durationMaxCv)}).`, evidence }]
            const tagged = pattern.filter((l) => l.cap !== undefined)
            const alive = pattern.filter((l) => l.alive === true).length
            const silent = pattern.filter((l) => l.alive === false).length
            const share = (n: number) => n / pattern.length

            let deductions: Deduction[] = []
            let title = 'Connections end after the same duration'
            let severity: Severity = 'warning'
            let nextCheck: FindingDraft['nextCheck']
            if (share(tagged.length) >= 0.5) {
                const first = tagged[0]!.cap!
                facts.push({ text: `The proxy announced its own duration cap (duration=${first.durationMs} ms) right before closing ${tagged.length} of these ${pattern.length} connections.`, evidence: tagged.slice(-3).map((l) => ev(l.cap!.seq, l.cap!.t, 'proxy cap tag')) })
                title = 'The proxy closes connections at its duration cap'
                severity = 'info'
                nextCheck = { description: 'Raise the proxy\'s maximum duration, or rely on the client resuming with Last-Event-ID after each cap.' }
            } else if (share(alive) >= 0.75) {
                facts.push({ text: `Bytes were still arriving when each connection was cut (the last byte came ${fmtMs(median(pattern.map((l) => l.idleMs ?? 0)) ?? 0)} before the close).`, evidence: [] })
                deductions = [{ statement: `Likely: a maximum-duration cap of about ${fmtMs(avg)} somewhere on the path (the server, a proxy or a load balancer).`, confidence: 'medium', basis: pattern.map((l) => l.endSeq), alternatives: ['A scheduled restart or deploy cycle that happens to fit this period.', 'The server recycles connections on a timer by design.'] }]
                nextCheck = { description: 'Look for connection-time limits (proxy_read_timeout, ALB idle or max duration, server keep-alive settings) near this duration.' }
            } else if (share(silent) >= 0.75) {
                facts.push({ text: `Each connection had been silent for about ${fmtMs(median(pattern.map((l) => l.idleMs ?? 0)) ?? 0)} before it was closed.`, evidence: [] })
                deductions = [{ statement: `Likely: an idle timeout of about ${fmtMs(median(pattern.map((l) => l.idleMs ?? 0)) ?? 0)} (the connection is closed after a stretch with no bytes).`, confidence: 'low', basis: pattern.map((l) => l.endSeq), alternatives: ['The producer finished a batch and closed on purpose.', 'A proxy times out streams that send no heartbeat.'] }]
                nextCheck = { description: 'Send a heartbeat comment more often than the shortest idle timeout on the path.' }
            } else {
                deductions = [{ statement: 'Likely: a fixed connection lifetime set somewhere on the path (a cap or an idle timeout), not random network loss.', confidence: 'low', basis: pattern.map((l) => l.endSeq), alternatives: ['A scheduled restart or deploy cycle that happens to fit this period.'] }]
            }
            return {
                key: 'reconnect.duration-pattern', severity, title,
                summary: `Connections keep ending after the same ${fmtMs(avg)}.`,
                facts, deductions, ...(nextCheck ? { nextCheck } : {}),
                limits: ['Lifetimes are measured on the client, from the open to the close it saw, so network delay adds a little to each.', 'Only dropped connections that had opened are counted; failed attempts have no lifetime.'],
                status: 'open', firstSeenT: patternFirstT ?? t, lastSeenT: t, occurrences: patternCount,
            }
        }

        const noteConnect = (o: { conn: number; t: number; seq: number }): void => {
            connects.push({ conn: o.conn, t: o.t, seq: o.seq })
            if (connects.length > KEEP_CONNECTS) connects.shift()
            let from = connects.length - 1
            while (from > 0 && o.t - (connects[from - 1]?.t ?? 0) <= th.loopWindowMs) from--
            const inWindow = connects.slice(from)
            if (inWindow.length >= th.loopMinConnections && (best === undefined || inWindow.length > best.count)) {
                const first = inWindow[0]!
                const last = inWindow[inWindow.length - 1]!
                best = { count: inWindow.length, first, last, connConns: inWindow.map((c) => c.conn) }
            }
        }

        return {
            onObservation(o, model) {
                const out: FindingDraft[] = []
                switch (o.kind) {
                    case 'comment': {
                        if (o.source === 'proxy') {
                            const tag = parseProxyComment(o.text.trim())
                            if (tag?.kind === 'cap') pendingCap.set(o.conn, { durationMs: tag.durationMs, seq: o.seq, t: o.t })
                        } else pendingCap.delete(o.conn)
                        break
                    }
                    case 'event':
                        pendingCap.delete(o.conn)
                        break
                    case 'connect': {
                        const wasFired = loopFired()
                        const before = best?.count
                        noteConnect(o)
                        if (loopFired() && (!wasFired || best?.count !== before)) { loopFirstT ??= o.t; loopCount++; out.push(buildLoop(model, o.t)) }
                        break
                    }
                    case 'reconnect': {
                        const dropped = model.conn(o.conn)
                        if (dropped && dropped.events === 0) {
                            if (run === 0) runStartSeq = o.seq
                            run++
                            runSeq = o.seq
                            maxRun = Math.max(maxRun, run)
                            if (run >= th.loopNoEventReconnects) { loopFirstT ??= o.t; loopCount++; out.push(buildLoop(model, o.t)) }
                        } else run = 0
                        break
                    }
                    case 'phase': {
                        if (o.phase === 'open' || o.phase === 'connecting') break
                        const c = model.conn(o.conn)
                        if (!c || c.endedT === undefined || c.endPhase !== 'reconnecting' || c.openT === undefined || counted.has(o.conn)) break
                        counted.add(o.conn)
                        const typicalGap = model.gaps.byte.count >= 3 ? model.gaps.byte.median() : undefined
                        const idleMs = c.lastByte ? Math.max(0, c.endedT - c.lastByte.t) : undefined
                        lifetimes.push({
                            conn: o.conn, openT: c.openT, endT: c.endedT, endSeq: c.endedSeq ?? o.seq, ms: c.endedT - c.openT, idleMs,
                            alive: typicalGap === undefined || idleMs === undefined ? undefined : idleMs <= 3 * typicalGap,
                            cap: pendingCap.get(o.conn),
                        })
                        if (lifetimes.length > KEEP) lifetimes.shift()
                        pendingCap.delete(o.conn)
                        const built = buildPattern(o.t)
                        if (built) {
                            patternFirstT ??= o.t
                            patternCount++
                            out.push({ ...built, firstSeenT: patternFirstT, occurrences: patternCount })
                        }
                        break
                    }
                    default:
                        break
                }
                return out
            },
            onEnd(endT, model) {
                const out: FindingDraft[] = []
                if (loopFired()) out.push(buildLoop(model, Math.max(model.nowT, endT)))
                return out
            },
        }
    },
}
