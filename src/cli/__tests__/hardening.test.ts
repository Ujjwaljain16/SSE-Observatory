import { afterEach, describe, expect, it } from 'vitest'
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import { main, EXIT, type CliIo } from '../index'
import { render, type Result } from '../output'
import { sanitizeText } from '../sanitize'
import { newHeader, serializeCapture, type Capture } from '../../core/capture/format'
import { healthyStart } from '../../core/testing/captureBuilder'
import { safeFetch } from '../safeFetch'

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
    return { io, written, get out() { return out }, get err() { return err } }
}

const servers: http.Server[] = []
afterEach(() => { for (const s of servers.splice(0)) { s.closeAllConnections(); s.close() } })
async function serve(handler: http.RequestListener): Promise<string> {
    const s = http.createServer(handler)
    servers.push(s)
    await new Promise<void>((r) => s.listen(0, '127.0.0.1', () => r()))
    return `http://127.0.0.1:${(s.address() as AddressInfo).port}`
}
const sse = (res: http.ServerResponse) => res.writeHead(200, { 'Content-Type': 'text/event-stream' })
const oneEvent = (_: http.IncomingMessage, res: http.ServerResponse) => { sse(res); res.write('id: 1\ndata: hello\n\n') }

describe('S12: a secret header does not follow a redirect to another origin', () => {
    it('safeFetch keeps Accept and drops the key once the origin changes', async () => {
        const seen: Array<Record<string, string | string[] | undefined>> = []
        const b = await serve((req, res) => { seen.push(req.headers); res.end('ok') })
        const a = await serve((_, res) => { res.writeHead(302, { Location: `${b}/landed` }); res.end() })
        const r = await safeFetch(`${a}/start`, { headers: { 'X-Api-Key': 'KEY-VALUE-1', Accept: 'text/event-stream' } })
        expect(await r.text()).toBe('ok')
        expect(r.redirected).toBe(true)
        expect(seen[0]!['x-api-key']).toBeUndefined()
        expect(seen[0]!['accept']).toBe('text/event-stream')
    })

    it('keeps the key on a redirect inside the same origin', async () => {
        const seen: Array<Record<string, string | string[] | undefined>> = []
        const a = await serve((req, res) => {
            if (req.url === '/start') { res.writeHead(302, { Location: '/next' }); res.end(); return }
            seen.push(req.headers); res.end('ok')
        })
        await (await safeFetch(`${a}/start`, { headers: { 'X-Api-Key': 'KEY-VALUE-2' } })).text()
        expect(seen[0]!['x-api-key']).toBe('KEY-VALUE-2')
    })

    it('stops after too many redirects and refuses a redirect to another scheme', async () => {
        const loop = await serve((req, res) => { res.writeHead(302, { Location: req.url + 'x' }); res.end() })
        await expect(safeFetch(`${loop}/a`)).rejects.toThrow(/Too many redirects/)
        const odd = await serve((_, res) => { res.writeHead(302, { Location: 'file:///etc/passwd' }); res.end() })
        await expect(safeFetch(`${odd}/a`)).rejects.toThrow(/not http or https/)
    })

    it('probe never sends --header-env values to the origin it was redirected to', async () => {
        const seen: Array<Record<string, string | string[] | undefined>> = []
        const b = await serve((req, res) => { seen.push(req.headers); oneEvent(req, res) })
        const a = await serve((_, res) => { res.writeHead(302, { Location: `${b}/stolen` }); res.end() })
        const h = host({}, { KEY: 'apikey-secret-CCCC' })
        await main(['probe', `${a}/s`, '--header-env', 'X-Api-Key=KEY', '--max-events', '1', '--duration', '5'], h.io)
        expect(seen.length).toBeGreaterThan(0)
        expect(seen.every((headers) => headers['x-api-key'] === undefined)).toBe(true)
    })
})

describe('S15: a probe that did not look says so', () => {
    it.each(['0', '-1', '99999999999'])('refuses --duration %s', async (value) => {
        const h = host()
        expect(await main(['probe', 'http://127.0.0.1:9/x', '--duration', value], h.io)).toBe(EXIT.usage)
    })

    it('a server that refuses the connection is "could not run" (3) whatever --fail-on says', async () => {
        const closed = await serve(() => {})
        const port = new URL(closed).port
        servers.pop()!.close() // now nothing listens there
        for (const failOn of ['error', 'critical', 'warning']) {
            const h = host()
            expect(await main(['probe', `http://127.0.0.1:${port}/x`, '--duration', '10', '--fail-on', failOn], h.io), `--fail-on ${failOn}`).toBe(EXIT.couldNotRun)
            expect(h.out).toContain('never answered')
        }
    }, 60_000)

    it('--timeout ends the wait for a server that accepts and never answers', async () => {
        const silent = await serve(() => {})
        const t0 = Date.now()
        const h = host()
        expect(await main(['probe', `${silent}/x`, '--duration', '30', '--timeout', '1'], h.io)).toBe(EXIT.couldNotRun)
        expect(Date.now() - t0).toBeLessThan(8000)
        expect(h.out).toContain('stopped: timeout')
    }, 30_000)

    it('a healthy stream that answers still exits 0', async () => {
        const ok = await serve(oneEvent)
        const h = host()
        expect(await main(['probe', `${ok}/x`, '--max-events', '1', '--duration', '5'], h.io)).toBe(EXIT.ok)
    })
})

describe('S09: a fast server cannot fill the probe\'s memory', () => {
    it('stops at --max-mb and says so', async () => {
        const chunk = 'data: ' + 'a'.repeat(64 * 1024) + '\n\n'
        const flood = await serve((req, res) => {
            sse(res)
            const t = setInterval(() => { for (let i = 0; i < 8; i++) res.write(chunk) }, 5)
            req.on('close', () => clearInterval(t))
        })
        const h = host()
        const t0 = Date.now()
        await main(['probe', `${flood}/x`, '--duration', '30', '--max-mb', '4'], h.io)
        expect(Date.now() - t0).toBeLessThan(15_000)
        expect(h.out).toContain('stopped: max-size')
        expect(h.out).toContain('--max-mb')
    }, 60_000)
})

describe('S07: warnings come with every shareable output', () => {
    it('report prints what may still be secret, and an id that looks like a token, without the value', async () => {
        const token = 'tok_9f8e7d6c5b4a3f2e1d0c9b8a7f6e5d4c'
        const b = healthyStart()
        b.frame('tick', token)
        const records = b.observations()
        const capture: Capture = { header: newHeader({ kind: 'local-full', source: { kind: 'fixture' } }), records }
        const h = host({ 'c.sse-capture': serializeCapture(capture) })
        const code = await main(['report', 'c.sse-capture', '--redact'], h.io)
        expect(code).toBe(EXIT.ok)
        expect(h.err).toMatch(/warning:/)
        expect(h.err).not.toContain(token)
    })
})

describe('S13: text from a stream cannot drive a terminal or break the XML', () => {
    // C0 controls, an escape sequence that sets the window title, and a noncharacter XML forbids
    const hostile = ['weird', '\u0001', 'line', '\u0000', '\u001b[31mred', '\u001b]0;title\u0007', String.fromCharCode(0xfffe)].join('')
    const CONTROL = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F]|￾|￿/

    // a finding whose text came from the stream, rendered every way the CLI can
    const result = (): Result => ({
        command: 'analyze', subject: `file ${hostile}`, notes: [`note ${hostile}`], coverage: [{ ruleId: `r${hostile}`, ruleVersion: 1, title: 't', status: 'not-evaluated', missingCapabilities: [], missingKinds: [], notes: [`needs ${hostile}`] }],
        findings: [{
            key: 'k', ruleId: 'r', ruleVersion: 1, severity: 'error', title: `title ${hostile}`, summary: `summary ${hostile}`,
            facts: [{ text: `fact ${hostile}`, evidence: [] }], deductions: [{ statement: `Likely: ${hostile}`, confidence: 'low', basis: [], alternatives: [] }],
            nextCheck: { description: `check ${hostile}` }, limits: [`limit ${hostile}`], status: 'open', firstSeenT: 0, lastSeenT: 0, occurrences: 1,
        }],
    })

    it.each(['human', 'md', 'junit'] as const)('%s output has none of them, and shows what they were', (format) => {
        const out = render(result(), format, { failOn: 'error', verbose: true })
        expect(out).not.toMatch(CONTROL)
        expect(out).toContain('\\u001B')
    })

    it('JUnit is still an XML document after that', () => {
        const out = render(result(), 'junit', { failOn: 'error', verbose: true })
        expect(out.startsWith('<?xml')).toBe(true)
        expect(out).toContain('</testsuites>')
    })

    it('sanitizeText keeps tab, newline and ordinary text, and replaces lone surrogates', () => {
        const plain = ['a\tb', 'c\r\nd', 'é 日本 😀'].join('\n')
        expect(sanitizeText(plain)).toBe(plain)
        expect(sanitizeText('x\uD800y')).toBe('x\\uD800y')
        expect(sanitizeText('\u0000\u007F\u0085')).toBe('\\u0000\\u007F\\u0085')
    })
})

describe('S14: secrets typed into the target are never echoed', () => {
    it('a URL the platform cannot parse is refused without quoting its userinfo or query', async () => {
        const h = host()
        const code = await main(['probe', 'http://user:pw0rdSECRET@[bad/x?token=TOKSECRET99', '--duration', '2', '--out', 'p.cap'], h.io)
        expect(code).toBe(EXIT.usage)
        for (const secret of ['pw0rdSECRET', 'TOKSECRET99', 'user:']) expect(h.out + h.err + Object.values(h.written).join('')).not.toContain(secret)
    })

    it('a secret echoed back by the server in the forms a JSON body or a URL would use is scrubbed', async () => {
        const secret = 'pa"ss\word/with+odd=chars'
        const echo = await serve((_, res) => { res.writeHead(503, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: `bad credential ${secret}`, again: encodeURIComponent(secret).toLowerCase() })) })
        const h = host({}, { PW: secret })
        await main(['probe', `${echo}/x`, '--auth-env', 'PW', '--duration', '3', '--out', 'p.cap'], h.io)
        const everything = h.out + h.err + Object.values(h.written).join('')
        expect(everything).not.toContain(secret)
        expect(everything).not.toContain(JSON.stringify(secret).slice(1, -1))
        expect(everything).not.toContain(encodeURIComponent(secret).toLowerCase())
    }, 30_000)
})

describe('S24: the built-in self test covers every shipped rule', () => {
    it('has a check for each of R01 to R13 and R15 (R14 is the comparison), and every check passes', async () => {
        const { selftestChecks } = await import('../selftest')
        const checks = selftestChecks()
        for (const id of ['R01', 'R02', 'R03', 'R04', 'R05', 'R06', 'R07', 'R08', 'R09', 'R10', 'R11', 'R12', 'R13', 'R15']) {
            expect(checks.some((c) => c.name.startsWith(`${id} `)), id).toBe(true)
        }
        for (const check of checks) expect(check.run(), check.name).toBeNull()
    })
})
