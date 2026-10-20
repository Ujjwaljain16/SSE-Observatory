import type { Fact, FindingDraft, Severity } from '../finding'
import type { Rule, RuleContext } from '../rule'
import type { StreamModel } from '../streamModel'
import { parseProxyComment } from '../../proxyTags'
import { ev, fmtMs, plural } from './util'

/**
 * R13 proxy.masking and proxy.upstream-mismatch: what the Observatory proxy's own tags reveal.
 *
 *  - proxy.masking: tagged proxy heartbeats (`: sse-proxy hb up_idle=<ms> n=<count>`) keep coming while `up_idle`,
 *    the proxy's own measure of how long the upstream has said nothing, keeps growing. The proxy is alive, the
 *    upstream is not. The thresholds follow R05's stall logic: from the stream's own origin rhythm when enough gaps
 *    were seen (a warning above 3x the p95 gap, an error above 5x), otherwise the profile's longest silence or the
 *    default; without a rhythm there is one threshold and passing it is an error.
 *  - proxy.upstream-mismatch: `x-sse-upstream-status` or `x-sse-upstream-content-type` differ from what the client
 *    got. The proxy forces text/event-stream, so this exposes a broken origin (F01) that the proxy hides.
 *
 * Nothing here is evaluated unless the capture carries proxy tags.
 */

interface Run {
    last: number
    growing: number
    first: { seq: number; t: number; upIdle: number }
    latest: { seq: number; t: number }
    fired: boolean
    /** How the threshold was set, worded for the finding. */
    thresholdFact: string
}

const header = (headers: Record<string, string>, name: string): string | undefined => {
    for (const [k, v] of Object.entries(headers)) if (k.toLowerCase() === name) return v
    return undefined
}
const mediaType = (value: string): string => (value.split(';')[0] ?? '').trim().toLowerCase()

export const proxyMasking: Rule = {
    id: 'proxy.masking',
    version: 1,
    title: 'Proxy masking an upstream problem',
    requires: ['comments', 'response'],
    create({ thresholds: th, profile }: RuleContext) {
        const runs = new Map<number, Run>()
        let episodes = 0
        let severity: Severity = 'warning'
        let firstSeenT: number | undefined
        let mismatches = 0
        let mismatchFirstT: number | undefined
        let mismatchSeverity: Severity = 'warning'

        const limitsFor = (model: StreamModel): { warnMs: number; errorMs: number; basis: 'cadence' | 'profile' | 'none' } => {
            const origin = model.gaps.origin
            const p95 = origin.p95()
            const hb = model.originHeartbeatMedian() ?? profile.expected?.heartbeatMs
            if (p95 !== undefined && origin.count >= th.stallMinSamples) {
                const warnMs = Math.max(th.stallP95Factor * p95, th.stallHeartbeatFactor * (hb ?? 0), th.stallMinSilenceMs)
                return { warnMs, errorMs: Math.max(th.stallErrorFactor * p95, th.stallErrorFactor * (hb ?? 0), warnMs), basis: 'cadence' }
            }
            if (profile.expected?.maxSilenceMs !== undefined) {
                const t = Math.max(profile.expected.maxSilenceMs, th.stallMinSilenceMs)
                return { warnMs: t, errorMs: t, basis: 'profile' }
            }
            return { warnMs: th.stallNoCadenceMs, errorMs: th.stallNoCadenceMs, basis: 'none' }
        }

        const maskingDraft = (run: Run, model: StreamModel, resolved: boolean): FindingDraft => {
            const origin = model.current()?.lastOrigin
            const evidence = [ev(run.first.seq, run.first.t, `up_idle=${run.first.upIdle} ms`), ev(run.latest.seq, run.latest.t, `up_idle=${run.last} ms`)]
            const facts: Fact[] = [
                { text: `${plural(run.growing + 1, 'proxy heartbeat')} kept arriving while the proxy-reported idle time of the upstream grew from ${fmtMs(run.first.upIdle)} to ${fmtMs(run.last)}.`, evidence },
                { text: run.thresholdFact, evidence: [] },
            ]
            if (origin) facts.push({ text: `The last output from the origin was at t=${fmtMs(origin.t)}.`, evidence: [ev(origin.seq, origin.t, 'last origin output')] })
            return {
                key: 'proxy.masking', severity, title: 'The proxy is alive, the upstream is silent',
                summary: `The proxy keeps the connection alive while the upstream has been silent for ${fmtMs(run.last)}.`,
                facts,
                deductions: [{
                    statement: 'Likely: the upstream (the origin behind the proxy) stopped sending, and the proxy\'s heartbeats hide that from the connection.',
                    confidence: 'medium', basis: evidence.map((e) => e.seq),
                    alternatives: ['The upstream is legitimately idle (no events to send).', 'Upstream data is buffered between the origin and the proxy.'],
                }],
                nextCheck: { description: 'Connect to the origin directly, bypassing the proxy, and see whether it is also silent.', command: 'curl -N -H "Accept: text/event-stream" "$ORIGIN_URL"' },
                limits: [
                    'Only evaluated when the capture carries the proxy\'s tags; without them nothing is evaluated.',
                    'up_idle is measured on the proxy\'s clock, not the client\'s.',
                ],
                status: resolved ? 'resolved' : 'open', firstSeenT: firstSeenT ?? run.first.t, lastSeenT: run.latest.t, occurrences: episodes,
            }
        }

        return {
            onObservation(o, model) {
                if (o.kind === 'response') {
                    const out: FindingDraft[] = []
                    const upStatus = header(o.headers, 'x-sse-upstream-status')
                    const upType = header(o.headers, 'x-sse-upstream-content-type')
                    const facts: Fact[] = []
                    let failing = false
                    const evidence = [ev(o.seq, o.t, 'response headers')]
                    if (upStatus !== undefined && upStatus.trim() !== String(o.status)) {
                        facts.push({ text: `The proxy reported that the upstream answered HTTP ${upStatus.trim()}, but the client received HTTP ${o.status}.`, evidence })
                        if (!/^2\d\d$/.test(upStatus.trim())) failing = true
                    }
                    if (upType !== undefined && mediaType(upType) !== mediaType(o.contentType)) {
                        facts.push({ text: `The proxy reported that the upstream sent Content-Type ${mediaType(upType) || 'none'}, but the client received ${mediaType(o.contentType) || 'none'}.`, evidence })
                        if (mediaType(upType) !== 'text/event-stream') failing = true
                    }
                    if (facts.length === 0) return out
                    mismatches++
                    mismatchFirstT ??= o.t
                    if (failing) mismatchSeverity = 'error'
                    out.push({
                        key: 'proxy.upstream-mismatch', severity: mismatchSeverity, title: 'The proxy changed the upstream response',
                        summary: 'What the origin sent differs from what the client received: the proxy may be presenting a failing origin as a healthy stream.',
                        facts,
                        deductions: [{
                            statement: 'Likely: the origin is not serving a valid event stream and the proxy is presenting its response as one.',
                            confidence: 'medium', basis: [o.seq],
                            alternatives: ['The proxy is configured to rewrite the status or content type on purpose.', 'The upstream request was redirected.'],
                        }],
                        nextCheck: { description: 'Request the origin directly and read its status and Content-Type.', command: 'curl -i -H "Accept: text/event-stream" "$ORIGIN_URL"' },
                        limits: ['Relies on the proxy\'s x-sse-upstream-* headers; a page on another origin can read them only if they are exposed.', 'Without proxy tags nothing is evaluated.'],
                        status: 'open', firstSeenT: mismatchFirstT, lastSeenT: o.t, occurrences: mismatches,
                    })
                    return out
                }

                if (o.kind !== 'comment' || o.source !== 'proxy') return
                const tag = parseProxyComment(o.text.trim())
                if (tag?.kind !== 'hb') return

                const out: FindingDraft[] = []
                const prior = runs.get(o.conn)
                let run: Run
                if (!prior || tag.upIdleMs < prior.last) {
                    // The upstream spoke (or this is the first heartbeat): a new stretch of idle time starts here.
                    if (prior?.fired) out.push(maskingDraft(prior, model, true))
                    run = { last: tag.upIdleMs, growing: 0, first: { seq: o.seq, t: o.t, upIdle: tag.upIdleMs }, latest: { seq: o.seq, t: o.t }, fired: false, thresholdFact: '' }
                } else {
                    run = prior
                    if (tag.upIdleMs > prior.last) run.growing++
                    run.last = tag.upIdleMs
                    run.latest = { seq: o.seq, t: o.t }
                }
                runs.set(o.conn, run)

                const lim = limitsFor(model)
                const level: Severity | undefined = run.last > lim.errorMs ? 'error' : run.last > lim.warnMs ? 'warning' : undefined
                if (run.growing >= 2 && level) {
                    if (!run.fired) { run.fired = true; episodes++; firstSeenT ??= o.t }
                    severity = level === 'error' || severity === 'error' ? 'error' : 'warning'
                    const how = lim.basis === 'cadence' ? `set from the stream's own rhythm (an error above ${fmtMs(lim.errorMs)})` : lim.basis === 'profile' ? 'the longest silence the stream profile allows' : 'the default, as the stream has no measured rhythm'
                    run.thresholdFact = `The stall threshold was ${fmtMs(lim.warnMs)}, ${how}.`
                    out.push(maskingDraft(run, model, false))
                }
                return out
            },
            coverage(model) {
                for (const c of model.conns.values()) {
                    if (c.sawProxy || (c.response && (header(c.response.headers, 'x-sse-proxy') !== undefined || header(c.response.headers, 'x-sse-upstream-status') !== undefined || header(c.response.headers, 'x-sse-upstream-content-type') !== undefined))) {
                        return { evaluated: true, notes: [] }
                    }
                }
                return { evaluated: false, notes: ['Not evaluated: this capture carries no proxy tags (no x-sse-* response headers, no ": sse-proxy" comments), so a masked upstream cannot be told from a direct connection.'] }
            },
        }
    },
}
