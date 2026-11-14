import { describe, expect, it } from 'vitest'
import { main, EXIT, type CliIo } from '../index'
import { newHeader, serializeCapture } from '../../core/capture/format'
import { bytesToBase64 } from '../../core/capture/base64'

/** An in-memory host, as in commands.test.ts. */
function host(files: Record<string, string>) {
    const written: Record<string, string> = {}
    let out = ''
    let err = ''
    const io: CliIo = {
        out: (t) => { out += t }, err: (t) => { err += t },
        readText: async (p) => { if (p in files) return files[p]!; throw new Error('ENOENT') },
        writeText: async (p, t) => { written[p] = t; files[p] = t },
        env: {},
    }
    return { io, written, get out() { return out }, get err() { return err } }
}

const BODY = [
    'id: 1\ndata: {"user":"ann","ssn":"123-45-6789","note":"see ACME-123456 for details"}\n\n',
    'id: 2\ndata: {"n":2}\n\n',
].join('')
const bytes = new TextEncoder().encode(BODY)
const local = serializeCapture({
    header: newHeader({ kind: 'local-full', source: { kind: 'fixture' }, request: { url: 'http://x.test/s', method: 'GET', headers: { 'x-request-id': 'req-7f3a' } } }),
    records: [
        { seq: 0, t: 0, conn: 0, kind: 'connect', attempt: 0, url: 'http://x.test/s', method: 'GET', headerNames: ['accept'], sentLastEventId: '' },
        { seq: 1, t: 5, conn: 0, kind: 'response', status: 200, contentType: 'text/event-stream', redirected: false, headers: { 'content-type': 'text/event-stream' }, ttfbMs: 5 },
        { seq: 2, t: 10, conn: 0, kind: 'chunk', bytes: bytes.length, b64: bytesToBase64(bytes) },
    ],
})
const policy = JSON.stringify({ version: 1, extraKeys: ['ssn'], extraPatterns: [{ name: 'ticket', pattern: 'ACME-\\d{6}' }], keepHeaders: ['x-request-id'] })

describe('--redact-policy', () => {
    it('redact: replaces what the policy names, says so, and the file says custom', async () => {
        const h = host({ 'a.sse-capture': local, 'p.json': policy })
        expect(await main(['redact', 'a.sse-capture', '--output', 'out.sse-capture', '--redact-policy', 'p.json'], h.io)).toBe(EXIT.ok)
        const out = h.written['out.sse-capture']!
        expect(out).not.toContain('123-45-6789')
        expect(out).not.toContain('ACME-123456')
        expect(out).toContain('"policy":"custom"')
        expect(out).toContain('req-7f3a') // the header the policy keeps
        expect(h.out).toContain('built-in rules plus 1 extra key name, 1 extra pattern, 1 kept header')
    })

    it('redact without the flag uses the built-in rules only', async () => {
        const h = host({ 'a.sse-capture': local })
        expect(await main(['redact', 'a.sse-capture', '--output', 'out.sse-capture'], h.io)).toBe(EXIT.ok)
        const out = h.written['out.sse-capture']!
        expect(out).toContain('ACME-123456')
        expect(out).toContain('"policy":"default"')
        expect(h.out).not.toContain('built-in rules plus')
    })

    it('report: the shared report holds none of what the policy names', async () => {
        const h = host({ 'a.sse-capture': local, 'p.json': policy })
        expect(await main(['report', 'a.sse-capture', '--redact', '--redact-policy', 'p.json', '--output', 'r.md'], h.io)).toBe(EXIT.ok)
        expect(h.written['r.md']).not.toContain('ACME-123456')
        expect(h.written['r.md']).not.toContain('123-45-6789')
    })

    it('curl: takes the policy too (a capture file, redacted on the way)', async () => {
        const h = host({ 'a.sse-capture': local, 'p.json': policy })
        expect(await main(['curl', 'a.sse-capture', '--redact', '--redact-policy', 'p.json'], h.io)).toBe(EXIT.ok)
        expect(h.out).toContain('curl')
    })

    it('says exactly what is wrong with a policy, as a usage error, and writes nothing', async () => {
        const bad = JSON.stringify({ extraKeys: [''], keepHeaders: ['Authorization'], extraPatterns: [{ name: 'a', pattern: '(a+)+$' }], nope: 1 })
        const h = host({ 'a.sse-capture': local, 'bad.json': bad })
        let code = 0
        try { code = await main(['redact', 'a.sse-capture', '--output', 'out.sse-capture', '--redact-policy', 'bad.json'], h.io) } catch (e) { code = -1; throw e }
        expect(code).toBe(EXIT.usage)
        expect(h.err).toContain('The redaction policy in "bad.json" is not valid')
        expect(h.err).toContain('"Authorization" carries credentials')
        expect(h.err).toContain('exponentially')
        expect(h.err).toContain('Unknown field "nope"')
        expect(h.written['out.sse-capture']).toBeUndefined()
    })

    it('refuses a file that cannot be read, is not JSON, or holds no rules', async () => {
        for (const [file, message] of [['missing.json', /Cannot read a redaction policy/], ['junk.json', /not valid JSON/], ['empty.json', /holds no rules/]] as const) {
            const g = host({ 'a.sse-capture': local, 'junk.json': '{ nope', 'empty.json': '{}' })
            expect(await main(['redact', 'a.sse-capture', '--output', 'o', '--redact-policy', file], g.io), file).toBe(EXIT.usage)
            expect(g.err, file).toMatch(message)
        }
    })
})
