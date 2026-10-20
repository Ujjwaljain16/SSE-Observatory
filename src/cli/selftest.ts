import { SSEParser } from '../core/sse/sseParser'
import { analyze } from '../core/diagnostics/engine'
import { capture as build, healthyStart, type CaptureBuilder } from '../core/testing/captureBuilder'
import { newHeader, parseCapture, serializeCapture, type Capture } from '../core/capture/format'
import { redactCapture } from '../core/capture/redact'
import { bytesToBase64 } from '../core/capture/base64'
import type { StreamProfile } from '../core/diagnostics/thresholds'
import type { EngineInput } from '../core/diagnostics/streamModel'

export interface SelftestCheck { name: string; run(): string | null }

const keysOf = (b: CaptureBuilder, profile?: StreamProfile): string[] =>
    analyze(b.build() as EngineInput[], { ...(profile ? { profile } : {}), endT: b.now }).findings.map((f) => f.key)

const steady = (n: number) => healthyStart().repeat(n, 1000, (b, i) => b.frame('tick', String(i + 1)))
const expectKey = (keys: string[], key: string): string | null => (keys.some((k) => k === key || k.startsWith(`${key}:`)) ? null : `expected ${key}, got [${keys.join(', ')}]`)
const expectNone = (keys: string[]): string | null => (keys.length === 0 ? null : `expected no findings, got [${keys.join(', ')}]`)

/** Each rule is run against a stream that should trigger it and one that should not. Virtual time, no sockets, a few milliseconds. */
export function selftestChecks(): SelftestCheck[] {
    const declared: StreamProfile = { sequence: { useSseId: true, policy: 'consecutive' } }
    const numbered = (ids: number[]) => {
        const b = healthyStart()
        ids.forEach((id) => b.silence(100).frame('tick', String(id)))
        // the probe would extract the number; stand in for it
        return { b, records: b.build().map((r) => (r.kind === 'event' ? { ...r, extracted: { seq: Number(r.sseId) }, dataHash: `h${r.dataBytes}` } : r)) as EngineInput[] }
    }
    return [
        {
            name: 'SSE parser reads a frame split across chunks',
            run() {
                const seen: string[] = []
                const parser = new SSEParser({ onMessage: (m) => seen.push(`${m.event}:${m.data}:${m.id}`) })
                for (const piece of ['event: tick\nid: 7\nda', 'ta: hel', 'lo\n\n']) parser.feed(piece)
                return seen.length === 1 && seen[0] === 'tick:hello:7' ? null : `unexpected result ${JSON.stringify(seen)}`
            },
        },
        { name: 'R01 flags a wrong content type, and is silent for a correct one', run: () => expectKey(keysOf(build().connect().response({ contentType: 'text/html' })), 'proto.content-type') ?? expectNone(keysOf(steady(3))) },
        { name: 'R01 flags a failing status', run: () => expectKey(keysOf(build().connect().response({ status: 502, contentType: 'text/plain' })), 'http.status') },
        { name: 'R05 flags a stream that goes silent', run: () => expectKey(keysOf(steady(12).silence(90_000)), 'stall.silent') },
        {
            name: 'R09 finds a gap under a declared sequence, and says nothing without one',
            run() {
                const { b, records } = numbered([1, 2, 3, 5, 6, 7, 8])
                const withContract = analyze(records, { profile: declared, endT: b.now }).findings.map((f) => f.key)
                const without = analyze(records, { endT: b.now }).findings.map((f) => f.key).filter((k) => k.startsWith('seq.'))
                return expectKey(withContract, 'seq.integrity:gap') ?? (without.length === 0 ? null : `continuity was judged without a declared sequence: [${without.join(', ')}]`)
            },
        },
        { name: 'R12 notices a credential-like query parameter without printing its value', run: () => expectKey(keysOf(build().connect({ url: 'http://x.test/s?token=abc123' }).response()), 'security.credentials-in-metadata') },
        {
            name: 'redaction removes a secret that was split across two chunks',
            run() {
                const text = new TextEncoder().encode('data: {"password":"canary-9f3a-secret"}\n\n')
                const cut = 22
                const local: Capture = {
                    header: newHeader({ kind: 'local-full', source: { kind: 'fixture' } }),
                    records: [
                        { seq: 0, t: 0, conn: 0, kind: 'chunk', bytes: cut, b64: bytesToBase64(text.slice(0, cut)) },
                        { seq: 1, t: 1, conn: 0, kind: 'chunk', bytes: text.length - cut, b64: bytesToBase64(text.slice(cut)) },
                    ],
                }
                const out = serializeCapture(redactCapture(local).capture)
                return out.includes('canary-9f3a-secret') ? 'the secret survived redaction' : null
            },
        },
        {
            name: 'a capture file survives a write and a read',
            run() {
                const c: Capture = { header: newHeader({ kind: 'local-full', source: { kind: 'fixture' } }), records: steady(3).build() }
                const back = parseCapture(serializeCapture(c))
                return back.integrity === 'ok' && back.capture.records.length === c.records.length ? null : `integrity ${back.integrity}, ${back.capture.records.length} of ${c.records.length} records`
            },
        },
    ]
}
