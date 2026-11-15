// @vitest-environment node
import { describe, it, expect } from 'vitest'
import { analyze } from '../../diagnostics'
import { bytesToBase64 } from '../base64'
import { newHeader, serializeCapture, type Capture } from '../format'
import { redactCapture } from '../redact'
import { buildReport, toCurl } from '../derived'
import { parseScenarioText, toScenario, serializeScenario } from '../../scenario'

const CANARIES = ['canary-password-9f3a', 'canary-bearer-Zx81Qw77Lm', 'canary-cookie-5521']

const text = [
    ': hello\n\n',
    'id: 1\ndata: {"user":"ann","password":"canary-password-9f3a"}\n\n',
    'id: 2\ndata: Authorization: Bearer canary-bearer-Zx81Qw77Lm\n\n',
].join('')
const bytes = new TextEncoder().encode(text)

const local = (): Capture => ({
    header: newHeader({
        kind: 'local-full',
        source: { kind: 'cli', client: 'node-undici' },
        request: { url: 'https://api.test/stream?token=abc', method: 'GET', headers: { Authorization: 'Bearer canary-bearer-Zx81Qw77Lm', Cookie: 'sid=canary-cookie-5521' } },
    }),
    records: [
        { seq: 0, t: 0, conn: 0, kind: 'connect', attempt: 0, url: 'https://api.test/stream?token=[redacted]', method: 'GET', headerNames: ['authorization', 'cookie'], sentLastEventId: '' },
        { seq: 1, t: 20, conn: 0, kind: 'response', status: 200, contentType: 'text/event-stream', redirected: false, headers: { 'content-type': 'text/event-stream' }, ttfbMs: 20 },
        { seq: 2, t: 30, conn: 0, kind: 'chunk', bytes: 10, b64: bytesToBase64(bytes.slice(0, 10)) },
        { seq: 3, t: 40, conn: 0, kind: 'chunk', bytes: bytes.length - 10, b64: bytesToBase64(bytes.slice(10)) },
        { seq: 4, t: 41, conn: 0, kind: 'event', event: 'message', sseId: '1', dataBytes: 40 },
        { seq: 5, t: 42, conn: 0, kind: 'event', event: 'message', sseId: '2', dataBytes: 40 },
    ],
})

describe('capture to report, curl and scenario', () => {
    it('no canary reaches any output that is built from the redacted capture', () => {
        const { capture } = redactCapture(local())
        const analysis = analyze(capture.records as never)
        const outputs = [
            serializeCapture(capture),
            toCurl(capture, { shell: 'posix' }),
            toCurl(capture, { shell: 'powershell' }),
            buildReport(capture, analysis, { format: 'md' }),
            buildReport(capture, analysis, { format: 'html' }),
            buildReport(capture, analysis, { format: 'json' }),
            serializeScenario(toScenario(capture, analysis).scenario),
        ]
        outputs.forEach((out, i) => { for (const canary of CANARIES) expect(out, `output ${i}`).not.toContain(canary) })
    })

    it('the scenario made from a capture is valid and holds no secret', () => {
        const { capture } = redactCapture(local())
        const { scenario } = toScenario(capture, analyze(capture.records as never))
        const parsed = parseScenarioText(serializeScenario(scenario))
        expect(parsed.errors).toEqual([])
        expect(JSON.stringify(scenario)).toContain('${ENV:')
    })

    it('a local capture cannot be handed to the sharing functions', () => {
        const local1 = local()
        // @ts-expect-error toCurl accepts only a RedactedCapture
        expect(() => toCurl(local1)).not.toThrow()
    })
})
