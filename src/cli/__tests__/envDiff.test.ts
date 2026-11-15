import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { main, EXIT, type CliIo } from '../index'
import { parseArgs } from '../args'
import { sideArgs } from '../commandsEnvDiff'
import { startFixtureServer, type FixtureServer } from '../../fixtures/server'

/** An in-memory host, as in commands.test.ts. */
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
    return { io, written, get out() { return out }, get err() { return err }, all: () => out + err + Object.values(written).join('\n') }
}

let fixtures: FixtureServer
beforeAll(async () => { fixtures = await startFixtureServer({ port: 0 }) })
afterAll(async () => { await fixtures.close() })

const healthy = () => fixtures.urlFor('f09-healthy', { scale: 0.1 })
const buffered = () => fixtures.urlFor('f09-buffered', { scale: 0.1 })

describe('sideArgs', () => {
    it('gives each side the shared credential flags, replaced by its own where it has some', () => {
        const args = parseArgs(['env-diff', 'a', 'b', '--auth-env', 'SHARED', '--auth-env-b', 'ONLY_B', '--cookie-env-a', 'COOKIE_A', '--query-env', 'k=SHARED_Q', '--query-env-b', 'k=B_Q'])
        const a = sideArgs(args, 'a')
        const b = sideArgs(args, 'b')
        expect(a.flags['auth-env']).toBe('SHARED')
        expect(b.flags['auth-env']).toBe('ONLY_B')
        expect(a.flags['cookie-env']).toBe('COOKIE_A')
        expect(b.flags['cookie-env']).toBeUndefined()
        expect(a.multi['query-env']).toEqual(['k=SHARED_Q'])
        expect(b.multi['query-env']).toEqual(['k=B_Q'])
    })

    it('does not change the arguments it was given', () => {
        const args = parseArgs(['env-diff', 'a', 'b', '--auth-env', 'S', '--auth-env-b', 'B'])
        sideArgs(args, 'b')
        expect(args.flags['auth-env']).toBe('S')
    })
})

describe('env-diff', () => {
    it('reads two paths at once and finds the difference in only one of them, without naming a layer', async () => {
        const h = host()
        const code = await main(['env-diff', healthy(), buffered(), '--label-a', 'origin', '--label-b', 'edge', '--duration', '20', '--fail-on', 'warning'], h.io)
        expect(code).toBe(EXIT.gateFailed)
        expect(h.out).toContain('sse-doctor env-diff')
        expect(h.out).toContain('origin vs edge')
        expect(h.out).toContain('compare.chunk-sizes')
        expect(h.out).toMatch(/origin http:\/\/127\.0\.0\.1:\d+\/f09\/healthy[^\n]*events/)
        expect(h.out).toMatch(/edge http:\/\/127\.0\.0\.1:\d+\/f09\/buffered[^\n]*events/)
        expect(h.out).toContain('which hop caused it cannot be told')
        expect(h.out).not.toMatch(/nginx|cloudflare/i)
    })

    it('exits 0 when the gate is above the difference, and reports each side on its own', async () => {
        const h = host()
        expect(await main(['env-diff', healthy(), buffered(), '--duration', '20'], h.io)).toBe(EXIT.ok) // a warning does not fail the default gate (error)
        expect(h.out).toContain('on its own: no findings')
        expect(h.out).toContain('A http://')
        expect(h.out).toContain('B http://')
    })

    it('finds nothing above info when the two are the same stream', async () => {
        const h = host()
        expect(await main(['env-diff', healthy(), healthy(), '--duration', '20', '--fail-on', 'warning'], h.io)).toBe(EXIT.ok)
    })

    it('gives one side its own credentials, and no output holds the secret', async () => {
        const env = { SIDE_B_TOKEN: 'canary-side-b-token-5c27' }
        const h = host({}, env)
        const code = await main(['env-diff', healthy(), fixtures.urlFor('f08-token', { scale: 0.05, n: 3 }), '--query-env-b', 'token=SIDE_B_TOKEN', '--duration', '10', '--out-a', 'a.sse-capture', '--out-b', 'b.sse-capture'], h.io)
        expect([EXIT.ok, EXIT.gateFailed]).toContain(code)
        expect(h.out).toMatch(/B http:\/\/127\.0\.0\.1:\d+\/[^\n]*: \d+ events? in/) // B was let in: it saw events, so the token reached it
        expect(h.all()).not.toContain('canary-side-b-token-5c27')
    })

    it('saves both captures redacted, and comparing the saved files says the same as the run did', async () => {
        const h = host()
        await main(['env-diff', healthy(), buffered(), '--duration', '20', '--out-a', 'a.sse-capture', '--out-b', 'b.sse-capture'], h.io)
        expect(h.written['a.sse-capture']).toContain('"kind":"sanitized"')
        expect(h.written['b.sse-capture']).toContain('"kind":"sanitized"')
        expect(h.out).toContain('A capture written to a.sse-capture (redacted).')
        const again = host({ 'a.sse-capture': h.written['a.sse-capture']!, 'b.sse-capture': h.written['b.sse-capture']! })
        await main(['compare', 'a.sse-capture', 'b.sse-capture', '--fail-on', 'warning'], again.io)
        expect(again.out).toContain('compare.chunk-sizes')
    })

    it('a side that never answers is "could not run", and the other side is still reported', async () => {
        const h = host()
        const code = await main(['env-diff', healthy(), 'http://127.0.0.1:9/nothing', '--duration', '5'], h.io)
        expect(code).toBe(EXIT.couldNotRun)
        expect(h.out).toContain('the server never answered')
        expect(h.out).toMatch(/A http:\/\/127\.0\.0\.1:\d+\/f09\/healthy[^\n]*events/)
    }, 30_000)

    it('stops the other side at once when one cannot start (a variable that is not set)', async () => {
        const h = host()
        const t0 = Date.now()
        const code = await main(['env-diff', fixtures.urlFor('h01', { scale: 0.05, n: 500 }), healthy(), '--auth-env-b', 'NOT_SET', '--duration', '30'], h.io)
        expect(code).toBe(EXIT.usage)
        expect(h.err).toContain('NOT_SET')
        expect(Date.now() - t0).toBeLessThan(8000) // it did not wait out the 30 s
    }, 30_000)

    it('an interrupted run reports what it saw and exits 130', async () => {
        const controller = new AbortController()
        const h = host()
        h.io.signal = controller.signal
        const running = main(['env-diff', fixtures.urlFor('h01', { scale: 0.05, n: 500 }), fixtures.urlFor('h01', { scale: 0.05, n: 500 }), '--duration', '30'], h.io)
        await new Promise((r) => setTimeout(r, 700))
        controller.abort()
        expect(await running).toBe(EXIT.interrupted)
        expect(h.out).toContain('sse-doctor env-diff')
    }, 30_000)

    it('needs two http(s) URLs', async () => {
        for (const argv of [['env-diff'], ['env-diff', healthy()], ['env-diff', healthy(), 'ftp://x/y'], ['env-diff', 'file:///etc/passwd', healthy()]]) {
            const h = host()
            expect(await main(argv, h.io), argv.join(' ')).toBe(EXIT.usage)
            expect(h.err).toContain('Usage: sse-doctor env-diff')
        }
    })
})
