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
        {
            name: 'R02 raises one finding per kind of framing violation, not one per occurrence',
            run() {
                const b = healthyStart()
                for (let i = 0; i < 3; i++) b.violation('UNKNOWN_FIELD', `field ${i}`)
                b.violation('UNTERMINATED_FRAME')
                const keys = keysOf(b)
                return expectKey(keys, 'proto.framing:UNKNOWN_FIELD') ?? expectKey(keys, 'proto.framing:UNTERMINATED_FRAME') ?? (keys.filter((k) => k === 'proto.framing:UNKNOWN_FIELD').length === 1 ? null : 'one finding per code expected')
            },
        },
        { name: 'R03 hints at a compressed response', run: () => expectKey(keysOf(build().connect().response({ headers: { 'content-encoding': 'gzip' } }).frame()), 'proto.headers-hints') },
        { name: 'R04 measures slow response headers', run: () => expectKey(keysOf(build().connect().at(4200).response().frame()), 'timing.first-event') },
        {
            name: 'R06 raises a hypothesis, not a fact, for events that arrive in periodic lumps',
            run() {
                const b = healthyStart()
                for (let burst = 0; burst < 6; burst++) { b.silence(3000); for (let i = 0; i < 12; i++) b.frame('tick', String(burst * 12 + i), 40) }
                return expectKey(keysOf(b), 'delivery.bursty')
            },
        },
        {
            name: 'R07 notices a reconnect loop',
            run() {
                const b = build().connect().response({ status: 502, contentType: 'text/plain' })
                for (let i = 0; i < 4; i++) b.silence(1000).reconnect({ delayMs: 1000 }).silence(1000).connect().response({ status: 502, contentType: 'text/plain' })
                return expectKey(keysOf(b), 'reconnect.loop')
            },
        },
        {
            name: 'R08 sees a resume that skipped events, only under a declared sequence',
            run() {
                const b = healthyStart()
                for (let i = 1; i <= 5; i++) b.silence(100).frame('tick', String(i))
                b.reconnect({ lastEventIdSent: '5' }).connect({ sentLastEventId: '5' }).response()
                for (let i = 9; i <= 12; i++) b.silence(100).frame('tick', String(i))
                const records = b.build().map((r) => (r.kind === 'event' ? { ...r, extracted: { seq: Number(r.sseId) } } : r)) as EngineInput[]
                const found = analyze(records, { profile: declared, endT: b.now }).findings.map((f) => f.key)
                const undeclared = analyze(records, { endT: b.now }).findings.map((f) => f.key).filter((k) => k.startsWith('resume.last-event-id:skipped'))
                return expectKey(found, 'resume.last-event-id:skipped') ?? (undeclared.length === 0 ? null : 'a skipped resume was judged without a declared sequence')
            },
        },
        { name: 'R10 notes the absence of heartbeats on a stream with long quiet periods', run: () => expectKey(keysOf(healthyStart().frame().silence(35_000).frame()), 'heartbeat.absent') },
        {
            name: 'R11 reports a page that processes events late, from page-domain samples',
            run() {
                const b = healthyStart()
                for (let i = 0; i < 30; i++) b.silence(100).frame('tick', String(i))
                const records: unknown[] = [...b.build()]
                for (let i = 0; i < 30; i++) records.push({ seq: 1000 + i, t: 4000 + i * 100, conn: 0, domain: 'page', kind: 'consumer', n: 1, queueDepth: i * 60, receivedT: i, processedT: i + 900, lagMs: 900 })
                return expectKey(analyze(records as EngineInput[], { endT: 8000 }).findings.map((f) => f.key), 'consumer.slow')
            },
        },
        { name: 'R12 notices a credential-like query parameter without printing its value', run: () => expectKey(keysOf(build().connect({ url: 'http://x.test/s?token=abc123' }).response()), 'security.credentials-in-metadata') },
        {
            name: 'R13 sees proxy heartbeats going on while the upstream it reports on grows idle',
            run() {
                const b = build().connect().response({ headers: { 'x-sse-proxy': 'observatory/1', 'x-sse-upstream-status': '200', 'x-sse-upstream-content-type': 'text/event-stream' } })
                for (let i = 0; i < 12; i++) { b.silence(1000).frame('tick', String(i + 1)); b.beat('proxy', `sse-proxy hb up_idle=200 n=${i + 1}`) }
                for (let k = 0; k < 8; k++) { b.silence(1000); b.beat('proxy', `sse-proxy hb up_idle=${1200 + k * 1000} n=${100 + k}`) }
                return expectKey(keysOf(b), 'proxy.masking')
            },
        },
        { name: 'R15 records a clock jump and does not read the time asleep as a stall', run: () => { const keys = keysOf(steady(3).silence(35_000).discontinuity(35_000, 'resume').silence(5000).frame()); return expectKey(keys, 'clock.discontinuity') ?? (keys.some((k) => k.startsWith('stall.silent')) ? 'the time across the jump was read as a stall' : null) } },
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
