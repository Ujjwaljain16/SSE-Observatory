// @vitest-environment node
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterEach, describe, expect, it } from 'vitest'
import { main, EXIT, type CliIo } from '../index'
import { base64ToBytes } from '../../core/capture/base64'
import { parseCapture } from '../../core/capture/format'

// Q14 (decided and implemented): `--no-redact` writes the recording as it is, wire bytes included, and a server may echo what it was sent. So it is
// REFUSED (exit 2, a usage error) when any option supplies a secret, with the reason and the two ways out; it stays allowed, with its warning, when
// none does, and that capture is byte-exact. Nothing is connected to and nothing is written when it is refused.

const SECRET = 'noredact-CANARY-4d81c9e2'
const LITERAL = 'literal-CANARY-0b6e7a13'
const ENV = { TOKEN: SECRET, COOKIE: `session=${SECRET}`, KEY: SECRET, QUERY: SECRET }

function host(env: Record<string, string> = {}) {
    const written: Record<string, string> = {}
    let out = ''
    let err = ''
    const io: CliIo = {
        out: (t) => { out += t }, err: (t) => { err += t },
        readText: async () => { throw new Error('ENOENT') }, writeText: async (p, t) => { written[p] = t },
        env,
    }
    return { io, written, get out() { return out }, get err() { return err } }
}

const servers: http.Server[] = []
afterEach(() => { for (const s of servers.splice(0)) { s.closeAllConnections(); s.close() } })

/** A server that counts the requests it gets and answers with `body` (bytes written exactly as given). */
async function serve(body: string, hits: string[] = []): Promise<string> {
    const s = http.createServer((req, res) => {
        hits.push(req.url ?? '')
        res.writeHead(200, { 'Content-Type': 'text/event-stream' })
        res.write(body)
        setTimeout(() => res.end(), 20)
    })
    servers.push(s)
    await new Promise<void>((r) => s.listen(0, '127.0.0.1', () => r()))
    return `http://127.0.0.1:${(s.address() as AddressInfo).port}`
}

const BASE = ['--max-events', '1', '--duration', '4']
const EVERYTHING = (h: ReturnType<typeof host>) => h.out + h.err + Object.values(h.written).join('')

describe('Q14: --no-redact is refused when an option supplies a secret', () => {
    it.each([
        ['--auth-env', ['--auth-env', 'TOKEN']],
        ['--cookie-env', ['--cookie-env', 'COOKIE']],
        ['--header-env X-Api-Key', ['--header-env', 'X-Api-Key=KEY']],
        ['--header X-Literal', ['--header', `X-Literal: ${LITERAL}`]],
        ['--query-env token', ['--query-env', 'token=QUERY']],
    ])('%s: exit 2, nothing connected, nothing written, the reason and both ways out are given, no value is printed', async (shown, flags) => {
        const hits: string[] = []
        const url = await serve('id: 1\ndata: hi\n\n', hits)
        const h = host(ENV)
        const code = await main(['probe', `${url}/s`, ...flags, ...BASE, '--no-redact', '--out', 'raw.sse-capture'], h.io)
        expect(code).toBe(EXIT.usage)
        expect(hits, 'the request was never made').toEqual([])
        expect(h.written, 'no file').toEqual({})
        expect(h.err).toContain(shown)
        expect(h.err).toContain('--no-redact')
        expect(h.err).toMatch(/echo|as recorded|wire bytes|may contain/i)
        expect(h.err).toMatch(/without --no-redact/i)
        expect(h.err).toMatch(/without (the|those|these) (secret )?options/i)
        expect(h.err).not.toMatch(/may contain secrets\. Do not share it/) // the allowed case's warning is not printed for a refusal
        expect(EVERYTHING(h)).not.toContain(SECRET)
        expect(EVERYTHING(h)).not.toContain(LITERAL)
    })

    it('a secret typed into the URL (user:password@, ?token=) is a secret option too, and neither the parameter name nor a value is printed', async () => {
        const hits: string[] = []
        const url = await serve('id: 1\ndata: hi\n\n', hits)
        for (const target of [`${url}/s?token=${SECRET}`, `${url.replace('http://', `http://user:${SECRET}@`)}/s`, `${url}/s?${SECRET}=1&api_key=${LITERAL}`]) {
            const h = host()
            const code = await main(['probe', target, ...BASE, '--no-redact', '--out', 'raw.sse-capture'], h.io)
            expect(code, target.replace(SECRET, '*')).toBe(EXIT.usage)
            expect(h.written).toEqual({})
            expect(h.err).toMatch(/URL/)
            expect(h.err).toContain('--no-redact')
            expect(EVERYTHING(h)).not.toContain(SECRET)
            expect(EVERYTHING(h)).not.toContain(LITERAL)
        }
        expect(hits).toEqual([])
    })

    it('the flag is refused with a secret option even without --out (it is never combined), and with --format json the refusal is on stderr only', async () => {
        const url = await serve('data: hi\n\n')
        const h = host(ENV)
        expect(await main(['probe', `${url}/s`, '--auth-env', 'TOKEN', '--no-redact', '--format', 'json', ...BASE], h.io)).toBe(EXIT.usage)
        expect(h.out).toBe('')
        expect(h.err).toContain('--no-redact')
    })

    it('every secret-bearing option is named in one message (the user sees all of them at once)', async () => {
        const url = await serve('data: hi\n\n')
        const h = host(ENV)
        const code = await main(['probe', `${url}/s`, '--auth-env', 'TOKEN', '--cookie-env', 'COOKIE', '--header-env', 'X-Api-Key=KEY', '--no-redact', '--out', 'x', ...BASE], h.io)
        expect(code).toBe(EXIT.usage)
        for (const name of ['--auth-env', '--cookie-env', '--header-env X-Api-Key']) expect(h.err).toContain(name)
    })

    it('env-diff: --no-redact with a secret on either side is refused, naming that side\'s option; nothing is connected to', async () => {
        const hits: string[] = []
        const url = await serve('id: 1\ndata: hi\n\n', hits)
        const h = host(ENV)
        const code = await main(['env-diff', `${url}/a`, `${url}/b`, '--auth-env-b', 'TOKEN', '--no-redact', '--out-a', 'a.sse-capture', '--out-b', 'b.sse-capture', ...BASE], h.io)
        expect(code).toBe(EXIT.usage)
        expect(hits).toEqual([])
        expect(h.written).toEqual({})
        expect(h.err).toContain('--auth-env-b')
        expect(EVERYTHING(h)).not.toContain(SECRET)
    })
})

describe('Q14: --no-redact with no secret option is still allowed, with its warning, and the capture is byte-exact', () => {
    // bytes that the default redaction would change: a JWT-shaped event id and an Authorization-like field in the payload, a lone CR, a UTF-8 character
    const BODY = 'id: eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dBjftJeZ4CVPmB92K27uhbUJU1p1r_wW1gFWFOEjXk\r\ndata: {"password":"hunter2-visible","msg":"café"}\r\n\r\n'

    const chunkBytes = (file: string): Buffer => {
        const parsed = parseCapture(file)
        expect(parsed.integrity).toBe('ok')
        const parts: Uint8Array[] = []
        for (const line of file.split('\n')) {
            let r: { kind?: string; b64?: string }
            try { r = JSON.parse(line) } catch { continue }
            if (r.kind === 'chunk' && r.b64) parts.push(base64ToBytes(r.b64))
        }
        return Buffer.concat(parts)
    }

    it('probe: exit 0, the warning is on stderr, the file holds exactly the bytes the server wrote, and the default capture of the same stream does not', async () => {
        const url = await serve(BODY)
        const raw = host()
        const code = await main(['probe', `${url}/s?scale=0.05&n=3&debug=true`, ...BASE, '--no-redact', '--out', 'raw.sse-capture'], raw.io)
        expect(code).toBe(EXIT.ok)
        expect(raw.err).toMatch(/warning: --no-redact writes a capture that may contain secrets\. Do not share it\./)
        expect(raw.out).toContain('NOT redacted')
        expect(chunkBytes(raw.written['raw.sse-capture']!).toString('utf8')).toBe(BODY)

        const safe = host()
        expect(await main(['probe', `${url}/s`, ...BASE, '--out', 'safe.sse-capture'], safe.io)).toBe(EXIT.ok)
        expect(safe.written['safe.sse-capture']).not.toContain('hunter2-visible')
    }, 30_000)

    it('env-diff: with no secret on either side, --no-redact writes both captures as they are, with the warning', async () => {
        const url = await serve(BODY)
        const h = host()
        const code = await main(['env-diff', `${url}/a`, `${url}/b`, ...BASE, '--no-redact', '--out-a', 'a.sse-capture', '--out-b', 'b.sse-capture'], h.io)
        expect(code).toBeLessThanOrEqual(1)
        expect(h.err).toMatch(/--no-redact writes captures that may contain secrets/)
        for (const f of ['a.sse-capture', 'b.sse-capture']) expect(chunkBytes(h.written[f]!).toString('utf8')).toBe(BODY)
    }, 30_000)
})
