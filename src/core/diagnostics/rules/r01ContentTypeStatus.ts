import type { Deduction, Evidence, FindingDraft } from '../finding'
import type { Rule } from '../rule'
import type { ConnectionState, EngineInput, StreamModel } from '../streamModel'
import { ev, plural } from './util'

/**
 * R01 proto.content-type and http.status.
 *
 * Error severity is reserved for what the WHATWG spec says makes a conforming EventSource fail the connection: the
 * client's own BAD_CONTENT_TYPE and HTTP_STATUS_NOT_200 violation records. A non-UTF-8 charset and a redirect are
 * only worth a warning / info, and are read from the response record.
 */

const ID_CONTENT_TYPE = 'proto.content-type'
const ID_STATUS = 'http.status'

const mediaType = (contentType: string): string => (contentType.split(';')[0] ?? '').trim().toLowerCase()

function contentTypeGuess(media: string): string {
    if (media === 'text/html') return 'Likely: an HTML page (an error page, a login redirect or a wrong route) was served instead of the stream.'
    if (media === 'application/json') return 'Likely: a JSON API endpoint answered instead of an SSE route, or an error body was returned.'
    if (media === 'text/plain') return 'Likely: the server (or a proxy in front of it) did not set the SSE Content-Type, so the stream is labelled plain text.'
    if (media === '') return 'Likely: the server sent no Content-Type header.'
    return 'Likely: the route does not produce an event stream, or a proxy rewrote the Content-Type.'
}

function statusGuess(status: number): Deduction | undefined {
    const make = (statement: string, alternatives: string[]): Deduction => ({ statement, confidence: 'low', basis: [], alternatives })
    if (status === 401 || status === 403) return make('Likely: the credentials were missing, expired or not accepted for this stream.', ['A proxy or gateway in front of the stream rejected the request.', 'The credential is valid but lacks permission for this stream.'])
    if (status === 404) return make('Likely: the URL path is wrong or the stream is not deployed there.', ['A proxy routes this path nowhere.', 'The resource exists only for other credentials.'])
    if (status === 204) return make('Likely: the server has nothing to stream for this request and told the client not to reconnect (HTTP 204).', ['The stream is finished and the server closes it this way on purpose.', 'The request lacks a parameter or credential that selects a stream.'])
    if (status === 429) return make('Likely: the server or a gateway is rate limiting this client.', ['Too many reconnect attempts in a short time.'])
    if (status >= 500 && status <= 599) return make('Likely: the server or the proxy in front of it failed or was unreachable.', ['A deploy or restart was in progress.', 'The upstream timed out behind a gateway.'])
    return undefined
}

interface Seen { count: number; firstSeenT: number; firstEvidence: Evidence[] }

export const contentTypeAndStatus: Rule = {
    id: 'proto.content-type',
    version: 1,
    title: 'Content-Type and HTTP status',
    requires: ['response'],
    create() {
        const seen = new Map<string, Seen>()
        const bump = (key: string, t: number, evidence: Evidence[]): Seen => {
            const prior = seen.get(key)
            const next: Seen = { count: (prior?.count ?? 0) + 1, firstSeenT: prior?.firstSeenT ?? t, firstEvidence: prior?.firstEvidence ?? evidence }
            seen.set(key, next)
            return next
        }
        const responseEvidence = (c: ConnectionState | undefined, note: string): Evidence[] => (c?.response ? [ev(c.response.seq, c.response.t, note)] : [])

        return {
            onObservation(o: EngineInput, model: StreamModel) {
                const out: FindingDraft[] = []
                const c = model.conn(o.conn)

                if (o.kind === 'violation' && o.code === 'BAD_CONTENT_TYPE') {
                    const contentType = c?.response?.contentType ?? ''
                    const media = mediaType(contentType)
                    const evidence = [...responseEvidence(c, 'response headers'), ev(o.seq, o.t, o.code)]
                    const s = bump('type', o.t, evidence)
                    const upstreamType = c?.response?.headers['x-sse-upstream-content-type']
                    const facts = [{ text: `The response Content-Type was "${contentType || 'none'}", not text/event-stream.`, evidence }]
                    const deductions: Deduction[] = [{ statement: contentTypeGuess(media), confidence: 'low', basis: evidence.map((e) => e.seq), alternatives: ['A proxy or CDN rewrote the header.', 'The wrong URL was requested.'] }]
                    if (upstreamType !== undefined && mediaType(upstreamType) !== media) {
                        facts.push({ text: `The proxy reports the upstream sent "${upstreamType}", but "${contentType || 'none'}" was delivered.`, evidence: responseEvidence(c, 'X-SSE-Upstream-Content-Type') })
                        deductions.push({ statement: 'Likely: the proxy replaced the upstream Content-Type, which hides what the origin really sends.', confidence: 'medium', basis: evidence.map((e) => e.seq), alternatives: ['The proxy forces text/event-stream for every response.'] })
                    }
                    out.push({
                        key: ID_CONTENT_TYPE, severity: 'error', title: 'Response is not an event stream',
                        summary: `The server answered with Content-Type "${contentType || 'none'}"; a conforming EventSource fails the connection.`,
                        facts, deductions,
                        nextCheck: { description: 'Request the URL with curl and read the response headers.', command: 'curl -sS -D - -o /dev/null -H "Accept: text/event-stream" "$URL"' },
                        limits: ['Only the headers the browser lets the page read are recorded.'],
                        status: 'open', firstSeenT: s.firstSeenT, lastSeenT: o.t, occurrences: s.count,
                    })
                }

                if (o.kind === 'violation' && o.code === 'HTTP_STATUS_NOT_200') {
                    const status = c?.response?.status
                    const evidence = [...responseEvidence(c, 'response'), ev(o.seq, o.t, o.code)]
                    const s = bump('status', o.t, evidence)
                    const guess = status !== undefined ? statusGuess(status) : undefined
                    out.push({
                        key: ID_STATUS, severity: 'error', title: 'Server did not answer 200',
                        summary: status !== undefined ? `The server answered HTTP ${status}${s.count > 1 ? ` (${plural(s.count, 'time')})` : ''}; a conforming EventSource fails the connection.` : 'The server answered with a status other than 200.',
                        facts: [{ text: status !== undefined ? `The response status was ${status}.` : o.detail, evidence }],
                        deductions: guess ? [{ ...guess, basis: evidence.map((e) => e.seq) }] : [],
                        nextCheck: { description: 'Request the URL with curl and read the status line and body.', command: 'curl -sS -i -H "Accept: text/event-stream" "$URL"' },
                        limits: ['The response body is not recorded, so the reason the server gives is not shown here.'],
                        status: 'open', firstSeenT: s.firstSeenT, lastSeenT: o.t, occurrences: s.count,
                    })
                }

                if (o.kind === 'response') {
                    const charset = /;\s*charset\s*=\s*"?([^";\s]+)/i.exec(o.contentType)?.[1]?.toLowerCase()
                    if (mediaType(o.contentType) === 'text/event-stream' && charset !== undefined && charset !== 'utf-8' && charset !== 'utf8') {
                        const evidence = [ev(o.seq, o.t, 'response')]
                        const s = bump('charset', o.t, evidence)
                        out.push({
                            key: `${ID_CONTENT_TYPE}:charset`, severity: 'warning', title: 'Event stream declares a non-UTF-8 charset',
                            summary: `The Content-Type declares charset "${charset}"; event streams are always decoded as UTF-8.`,
                            facts: [{ text: `The response Content-Type was "${o.contentType}".`, evidence }],
                            deductions: [{ statement: 'Likely: non-ASCII text in the stream will be decoded wrongly unless it is really UTF-8.', confidence: 'low', basis: [o.seq], alternatives: ['The stream is plain ASCII, so nothing is affected.'] }],
                            limits: [],
                            status: 'open', firstSeenT: s.firstSeenT, lastSeenT: o.t, occurrences: s.count,
                        })
                    }
                    if (o.redirected) {
                        const evidence = [ev(o.seq, o.t, 'response')]
                        const s = bump('redirect', o.t, evidence)
                        out.push({
                            key: 'http.redirect', severity: 'info', title: 'The request was redirected',
                            summary: 'The response came from a different URL than the one requested.',
                            facts: [{ text: 'The response was marked as redirected.', evidence }],
                            deductions: [],
                            limits: ['The final URL is not recorded.'],
                            status: 'open', firstSeenT: s.firstSeenT, lastSeenT: o.t, occurrences: s.count,
                        })
                    }
                }
                return out
            },
        }
    },
}
