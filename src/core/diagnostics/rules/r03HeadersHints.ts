import type { Evidence, FindingDraft, Severity } from '../finding'
import type { Rule } from '../rule'
import { ev } from './util'

/**
 * R03 proto.headers-hints: response headers that can make an intermediary buffer a stream. These are hints at low
 * confidence, never proof: only the headers listed in DIAGNOSTIC_RESPONSE_HEADERS are recorded, and a cross-origin
 * page can only read a few of them. When the response record carries no headers at all the rule is skipped (not
 * evaluated), because "absent" would be indistinguishable from "hidden".
 */

interface Hint { key: string; severity: Severity; title: string; fact: string; why: string }

export const headersHints: Rule = {
    id: 'proto.headers-hints',
    version: 1,
    title: 'Response header hints',
    requires: ['response'],
    create() {
        const counts = new Map<string, { count: number; firstSeenT: number }>()
        let sawHeaders = false
        let sawEmpty = false

        const emit = (hint: Hint, evidence: Evidence[], t: number): FindingDraft => {
            const prior = counts.get(hint.key)
            const next = { count: (prior?.count ?? 0) + 1, firstSeenT: prior?.firstSeenT ?? t }
            counts.set(hint.key, next)
            return {
                key: `proto.headers-hints:${hint.key}`, severity: hint.severity, title: hint.title,
                summary: hint.why,
                facts: [{ text: hint.fact, evidence }],
                deductions: [{ statement: 'Likely: this can contribute to an intermediary buffering the stream; it does not show that buffering happens.', confidence: 'low', basis: evidence.map((e) => e.seq), alternatives: ['No intermediary sits between the server and the client.', 'The intermediary is configured to stream regardless.'] }],
                nextCheck: { description: 'Compare the first-byte timing with and without the intermediary (request the origin directly).' },
                limits: ['A hint only. Header values the browser hides from the page (cross-origin) cannot be seen, so an absent header may be a hidden one.'],
                status: 'open', firstSeenT: next.firstSeenT, lastSeenT: t, occurrences: next.count,
            }
        }

        return {
            onObservation(o) {
                if (o.kind !== 'response' || o.status !== 200) return // an error response is not a stream; R01 reports it
                if (Object.keys(o.headers).length === 0) { sawEmpty = true; return }
                sawHeaders = true
                const h = o.headers
                const evidence = [ev(o.seq, o.t, 'response headers')]
                const out: FindingDraft[] = []
                const encoding = h['content-encoding']?.toLowerCase()
                if (encoding && /\b(gzip|br|deflate)\b/.test(encoding)) {
                    out.push(emit({ key: 'content-encoding', severity: 'warning', title: 'Event stream is compressed', fact: `The response has Content-Encoding: ${h['content-encoding']}.`, why: 'Compression often makes servers and proxies hold bytes back until a buffer fills.' }, evidence, o.t))
                }
                if (h['content-length'] !== undefined) {
                    out.push(emit({ key: 'content-length', severity: 'warning', title: 'Event stream has a Content-Length', fact: `The response has Content-Length: ${h['content-length']}.`, why: 'A streaming response normally has no length; one suggests the body is being assembled before it is sent.' }, evidence, o.t))
                }
                const cache = h['cache-control']
                if (cache === undefined || !/\bno-(cache|store)\b/i.test(cache)) {
                    out.push(emit({ key: 'cache-control', severity: 'info', title: 'No Cache-Control: no-cache', fact: cache === undefined ? 'The response has no Cache-Control header.' : `The response has Cache-Control: ${cache}.`, why: 'Without no-cache an intermediary may cache or hold the response.' }, evidence, o.t))
                }
                if (h['x-accel-buffering'] === undefined) {
                    out.push(emit({ key: 'x-accel-buffering', severity: 'info', title: 'No X-Accel-Buffering header', fact: 'The response has no X-Accel-Buffering header.', why: 'nginx buffers responses unless told not to with X-Accel-Buffering: no.' }, evidence, o.t))
                }
                return out
            },
            coverage() {
                if (sawEmpty && !sawHeaders) return { evaluated: false, notes: ['Skipped: the response record carries no headers (hidden from the page, or not recorded).'] }
                return { evaluated: true, notes: sawEmpty ? ['Some responses carried no headers and were skipped.'] : [] }
            },
        }
    },
}
