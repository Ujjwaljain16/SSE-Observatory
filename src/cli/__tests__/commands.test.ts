import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { main, EXIT, type CliIo } from '../index'
import { SecretRegistry, scrubbedIo } from '../secretRegistry'
import { parseArgs } from '../args'
import { newHeader, serializeCapture, type Capture } from '../../core/capture/format'
import { bytesToBase64 } from '../../core/capture/base64'
import { capture as build, healthyStart } from '../../core/testing/captureBuilder'
import { startFixtureServer, type FixtureServer } from '../../fixtures/server'

/** An in-memory host: files, environment, and everything written to stdout, stderr and files. */
function host(files: Record<string, string> = {}, env: Record<string, string> = {}) {
    const written: Record<string, string> = {}
    let out = ''
    let err = ''
    const io: CliIo = {
        out: (t) => { out += t }, err: (t) => { err += t },
        readText: async (p) => { if (p in files) return files[p]!; throw new Error('ENOENT') },
        writeText: async (p, t) => { written[p] = t; files[p] = t },
        env,
    }
    return { io, files, written, get out() { return out }, get err() { return err }, all: () => out + err + Object.values(written).join('\n') }
}

const asFile = (records: ReturnType<typeof build>, kind: 'local-full' | 'sanitized' = 'local-full'): string =>
    serializeCapture({ header: newHeader({ kind, source: { kind: 'fixture' } }), records: records.build() })

const wrongType = () => asFile(build().connect().response({ contentType: 'text/html' }))
const healthy = () => asFile(healthyStart().repeat(4, 1000, (b, i) => b.frame('tick', String(i + 1))))

describe('arguments', () => {
    it('rejects an option it does not know, and one that lacks its value', () => {
        expect(() => parseArgs(['analyze', 'x', '--bogus'])).toThrow(/Unknown option --bogus/)
        expect(() => parseArgs(['probe', 'u', '--duration'])).toThrow(/needs a value/)
        expect(parseArgs(['probe', 'u', '--header-env', 'A=B', '--header-env=C=D']).multi['header-env']).toEqual(['A=B', 'C=D'])
    })
})

describe('analyze', () => {
    it('exits 1 on an error finding and prints it with its evidence, and 0 on a healthy stream', async () => {
        const h = host({ 'bad.sse-capture': wrongType(), 'ok.sse-capture': healthy() })
        expect(await main(['analyze', 'bad.sse-capture'], h.io)).toBe(EXIT.gateFailed)
        expect(h.out).toContain('[ERROR]')
        expect(h.out).toContain('proto.content-type')
        const g = host({ 'ok.sse-capture': healthy() })
        expect(await main(['analyze', 'ok.sse-capture'], g.io)).toBe(EXIT.ok)
        expect(g.out).toContain('No findings.')
    })

    it('--fail-on moves the gate, and the other formats are well formed', async () => {
        const text = asFile(build().connect().response({ headers: { 'content-encoding': 'gzip' } }).repeat(3, 1000, (b, i) => b.frame('tick', String(i + 1))))
        const warn = host({ 'w.sse-capture': text })
        expect(await main(['analyze', 'w.sse-capture'], warn.io)).toBe(EXIT.ok)
        const strict = host({ 'w.sse-capture': text })
        expect(await main(['analyze', 'w.sse-capture', '--fail-on', 'info'], strict.io)).toBe(EXIT.gateFailed)

        const json = host({ 'b.sse-capture': wrongType() })
        await main(['analyze', 'b.sse-capture', '--format', 'json'], json.io)
        const parsed = JSON.parse(json.out)
        expect(parsed.schemaVersion).toBe(1)
        expect(parsed.findings.some((f: { key: string }) => f.key === 'proto.content-type')).toBe(true)

        const junit = host({ 'b.sse-capture': wrongType() })
        await main(['analyze', 'b.sse-capture', '--format', 'junit'], junit.io)
        expect(junit.out).toMatch(/<testsuite [^>]*failures="[1-9]/)
        expect(junit.out).toContain('<failure')
        expect(junit.out).toContain('<skipped')

        const md = host({ 'b.sse-capture': wrongType() })
        await main(['analyze', 'b.sse-capture', '--format', 'md'], md.io)
        expect(md.out).toContain('### ERROR')
    })

    it('reads an old .sse-record and says what it cannot evaluate', async () => {
        const v1 = JSON.stringify({ version: '1.0', events: [{ type: 'a', data: 'x', sseId: '1', deltaMs: 0 }, { type: 'a', data: 'y', sseId: '2', deltaMs: 100 }] })
        const h = host({ 'old.sse-record': v1 })
        expect(await main(['analyze', 'old.sse-record'], h.io)).toBe(EXIT.ok)
        expect(h.out).toContain('Not evaluated')
        expect(h.out).toContain('Imported an old .sse-record')
    })

    it('judges a sequence only when a profile declares it', async () => {
        const b = healthyStart()
        ;[1, 2, 3, 5, 6, 7, 8].forEach((id) => b.silence(100).frame('tick', String(id)))
        const records = b.build().map((r) => (r.kind === 'event' ? { ...r, extracted: { seq: Number(r.sseId) }, dataHash: `h${r.dataBytes}` } : r))
        const file = serializeCapture({ header: newHeader({ kind: 'local-full', source: { kind: 'fixture' } }), records })
        const none = host({ 'c.sse-capture': file })
        await main(['analyze', 'c.sse-capture'], none.io)
        expect(none.out).not.toContain('seq.integrity:gap')
        const declared = host({ 'c.sse-capture': file, 'p.json': JSON.stringify({ sequence: { useSseId: true, policy: 'consecutive' } }) })
        expect(await main(['analyze', 'c.sse-capture', '--profile', 'p.json'], declared.io)).toBe(EXIT.gateFailed)
        expect(declared.out).toContain('seq.integrity:gap')
    })

    it('usage and input problems have their own exit codes', async () => {
        expect(await main(['analyze'], host().io)).toBe(EXIT.usage)
        expect(await main(['analyze', 'nope.sse-capture'], host().io)).toBe(EXIT.couldNotRun)
        expect(await main(['analyze', 'x', '--fail-on', 'loud'], host({ x: wrongType() }).io)).toBe(EXIT.usage)
        const bad = host({ 'bad.txt': 'hello' })
        expect(await main(['analyze', 'bad.txt'], bad.io)).toBe(EXIT.usage)
        expect(bad.err).toContain('not JSON')
    })
})

const SECRET_TEXT = 'data: {"password":"canary-pass-77aa","n":1}\n\n'
const secretCapture = (): string => {
    const bytes = new TextEncoder().encode(`id: 1\n${SECRET_TEXT}`)
    const c: Capture = {
        header: newHeader({ kind: 'local-full', source: { kind: 'cli' }, request: { url: 'https://api.test/s?token=canary-query-55bb', method: 'GET', headers: { Authorization: 'Bearer canary-bearer-99cc' } } }),
        records: [
            { seq: 0, t: 0, conn: 0, kind: 'connect', attempt: 0, url: 'https://api.test/s?token=[redacted]', method: 'GET', headerNames: ['authorization'], sentLastEventId: '' },
            { seq: 1, t: 10, conn: 0, kind: 'response', status: 200, contentType: 'text/event-stream', redirected: false, headers: { 'content-type': 'text/event-stream' }, ttfbMs: 10 },
            { seq: 2, t: 20, conn: 0, kind: 'chunk', bytes: bytes.length, b64: bytesToBase64(bytes) },
            { seq: 3, t: 21, conn: 0, kind: 'event', event: 'message', sseId: '1', dataBytes: 30 },
        ],
    }
    return serializeCapture(c)
}
const CANARIES = ['canary-pass-77aa', 'canary-query-55bb', 'canary-bearer-99cc']

describe('sharing commands accept only redacted captures', () => {
    it('report and curl refuse a local capture, and work after redact or with --redact', async () => {
        for (const argv of [['report', 'c.sse-capture'], ['curl', 'c.sse-capture']]) {
            const h = host({ 'c.sse-capture': secretCapture() })
            expect(await main(argv, h.io)).toBe(EXIT.usage)
            expect(h.err).toContain('sse-doctor redact')
        }
        const h = host({ 'c.sse-capture': secretCapture() })
        expect(await main(['redact', 'c.sse-capture', '--output', 'clean.sse-capture'], h.io)).toBe(EXIT.ok)
        for (const canary of CANARIES) expect(h.written['clean.sse-capture']).not.toContain(canary)
        for (const argv of [['report', 'clean.sse-capture', '--format', 'md'], ['report', 'clean.sse-capture', '--format', 'html'], ['report', 'clean.sse-capture', '--format', 'json'], ['curl', 'clean.sse-capture']]) {
            expect(await main(argv, h.io)).toBe(EXIT.ok)
        }
        for (const canary of CANARIES) expect(h.all(), canary).not.toContain(canary)

        const direct = host({ 'c.sse-capture': secretCapture() })
        expect(await main(['report', 'c.sse-capture', '--redact'], direct.io)).toBe(EXIT.ok)
        for (const canary of CANARIES) expect(direct.all(), canary).not.toContain(canary)
    })

    it('curl accepts a URL and turns query values into variables', async () => {
        const h = host()
        expect(await main(['curl', 'https://api.test/s?token=canary-url-1234&x=1'], h.io)).toBe(EXIT.ok)
        expect(h.out).not.toContain('canary-url-1234')
        expect(h.out).toMatch(/STREAM_TOKEN/)
    })
})

describe('compare', () => {
    it('compares two captures and exits 0 when nothing differs materially', async () => {
        const h = host({ 'a.sse-capture': healthy(), 'b.sse-capture': healthy() })
        expect(await main(['compare', 'a.sse-capture', 'b.sse-capture'], h.io)).toBe(EXIT.ok)
        expect(await main(['compare', 'a.sse-capture'], h.io)).toBe(EXIT.usage)
    })
})

describe('SecretRegistry', () => {
    it('scrubs a value in every form it may appear in, longest first, and ignores values too short to scrub safely', () => {
        const s = new SecretRegistry()
        expect(s.register('s3cret-token')).toBe(true)
        expect(s.register('ab')).toBe(false)
        const encoded = encodeURIComponent('s3cret token/1')
        s.register('s3cret token/1')
        const text = `a s3cret-token b ${encoded} c ${Buffer.from('s3cret-token').toString('base64')} ab`
        expect(s.scrub(text)).toBe('a [REDACTED] b [REDACTED] c [REDACTED] ab')
    })

    it('wraps every sink of an io, including file writes', () => {
        const s = new SecretRegistry()
        s.register('hunter2-secret')
        const h = host()
        const io = scrubbedIo(h.io, s)
        io.out('out hunter2-secret'); io.err('err hunter2-secret'); void io.writeText!('f', 'file hunter2-secret')
        expect(h.out + h.err + h.written['f']).not.toContain('hunter2-secret')
    })
})

describe('probe', () => {
    let fixtures: FixtureServer
    beforeAll(async () => { fixtures = await startFixtureServer({ port: 0 }) })
    afterAll(async () => { await fixtures.close() })

    it('watches a real stream, analyzes it, and keeps secrets out of every output and the saved file', async () => {
        const env = { STREAM_TOKEN: 'canary-env-token-8d41', STREAM_AUTH: 'canary-env-auth-62f0' }
        const h = host({}, env)
        const url = fixtures.urlFor('f08-token', { scale: 0.05, n: 3 })
        const code = await main(['probe', url, '--query-env', 'token=STREAM_TOKEN', '--auth-env', 'STREAM_AUTH', '--duration', '10', '--out', 'p.sse-capture', '--header', 'X-Literal: canary-literal-33e7'], h.io)
        expect([EXIT.ok, EXIT.gateFailed]).toContain(code)
        expect(h.out).toContain('sse-doctor probe')
        expect(h.out).toMatch(/Observed [34] events/)
        expect(h.written['p.sse-capture']).toContain('"format":"sse-capture"')
        expect(h.written['p.sse-capture']).toContain('"kind":"sanitized"')
        for (const canary of ['canary-env-token-8d41', 'canary-env-auth-62f0', 'canary-literal-33e7']) expect(h.all(), canary).not.toContain(canary)
        expect(h.err).toContain('prefer --header-env')
    })

    it('says which variable is missing and sends nothing', async () => {
        const h = host({}, {})
        expect(await main(['probe', 'http://127.0.0.1:9/s', '--auth-env', 'NOT_SET'], h.io)).toBe(EXIT.usage)
        expect(h.err).toContain('NOT_SET')
    })

    it('a connection that cannot be made does not print the secret that was in its URL', async () => {
        const h = host({}, { K: 'canary-fail-secret-aa19' })
        const code = await main(['probe', 'http://127.0.0.1:9/s', '--query-env', 'key=K', '--duration', '5'], h.io)
        expect([EXIT.gateFailed, EXIT.couldNotRun]).toContain(code)
        expect(h.all()).not.toContain('canary-fail-secret-aa19')
    })

    it('stops at --max-events', async () => {
        const h = host()
        await main(['probe', fixtures.urlFor('h01', { scale: 0.02, n: 40 }), '--max-events', '4', '--duration', '10'], h.io)
        expect(h.out).toMatch(/Observed [4-6] events/)
    })
})

describe('selftest', () => {
    it('runs every rule check and redaction check', async () => {
        const h = host()
        expect(await main(['selftest'], h.io)).toBe(EXIT.ok)
        expect(h.out).toContain('R09')
        expect(h.out).toContain('redaction')
        expect(h.out).toContain('selftest passed')
    })
})
