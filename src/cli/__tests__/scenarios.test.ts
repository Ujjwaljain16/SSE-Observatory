import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { main, EXIT, type CliIo } from '../index'
import { serializeCapture } from '../../core/capture/format'
import { defaultRules } from '../../core/diagnostics/rules'
import { startFixtureServer, type FixtureServer } from '../../fixtures/server'
import { observeFixture } from '../../fixtures/__tests__/observeFixture'

function host(files: Record<string, string> = {}, env: Record<string, string> = {}, signal?: AbortSignal) {
    const written: Record<string, string> = {}
    let out = ''
    let err = ''
    const io: CliIo = {
        out: (t) => { out += t }, err: (t) => { err += t },
        readText: async (p) => { if (p in files) return files[p]!; throw new Error('ENOENT') },
        writeText: async (p, t) => { written[p] = t },
        env, ...(signal ? { signal } : {}),
    }
    return { io, written, get out() { return out }, get err() { return err }, all: () => out + err + Object.values(written).join('\n') }
}

const contract = { use_sse_id: true, policy: 'consecutive' }
const resumeScenario = (url: string, extra: Record<string, unknown> = {}, verify: unknown[] = ['no_unexplained_sequence_gaps', 'no_unexpected_duplicates', 'preserve_event_order']) => JSON.stringify({
    version: 1, name: 'resume', target: { url, sequence: contract, ...extra },
    steps: [{ collect_events: 4, timeout_ms: 10000 }, { disconnect: { mode: 'server' } }, { reconnect: { after_ms: 0 } }, { collect_events: 3, timeout_ms: 10000 }],
    verify,
})

describe('sse-doctor test', () => {
    it('passes a healthy resume, fails a resume that skips ids, and says why', async () => {
        const ok = host({ 'ok.json': resumeScenario('fixture://f06-resumes?scale=0.05') })
        expect(await main(['test', 'ok.json'], ok.io)).toBe(EXIT.ok)
        expect(ok.out).toContain('PASS')

        const bad = host({ 'bad.json': resumeScenario('fixture://f06-skips?scale=0.05') })
        expect(await main(['test', 'bad.json'], bad.io)).toBe(EXIT.gateFailed)
        expect(bad.out).toContain('FAIL')
        expect(bad.out).toMatch(/no_unexplained_sequence_gaps: .*4-6|numbers between/)
    })

    it('a sequence check without a declared contract is inconclusive (exit 4), never a silent pass, unless allowed', async () => {
        const text = JSON.stringify({ version: 1, name: 'x', target: { url: 'fixture://f06-resumes?scale=0.05' }, steps: [{ collect_events: 2, timeout_ms: 10000 }], verify: ['no_unexplained_sequence_gaps'] })
        const h = host({ 's.json': text })
        expect(await main(['test', 's.json'], h.io)).toBe(EXIT.inconclusive)
        expect(h.out).toContain('INCONCLUSIVE')
        expect(await main(['test', 's.json', '--allow-inconclusive'], host({ 's.json': text }).io)).toBe(EXIT.ok)
    })

    it('a step that times out fails with what was received', async () => {
        const text = JSON.stringify({ version: 1, name: 'slow', target: { url: 'fixture://h01?scale=1&n=5' }, steps: [{ collect_events: 3, timeout_ms: 300 }] })
        const h = host({ 's.json': text })
        expect(await main(['test', 's.json'], h.io)).toBe(EXIT.gateFailed)
        expect(h.out).toMatch(/received \d of 3 before the timeout/)
    })

    it('checks what the response should look like', async () => {
        const bad = JSON.stringify({ version: 1, name: 'type', target: { url: 'fixture://f01-text-html' }, expect: { content_type: 'text/event-stream', status: 200 }, steps: [{ wait: { ms: 50 } }] })
        const h = host({ 's.json': bad })
        expect(await main(['test', 's.json'], h.io)).toBe(EXIT.gateFailed)
        expect(h.out).toContain('expect content type')
    })

    it('reports JSON, JUnit and markdown', async () => {
        const files = { 'ok.json': resumeScenario('fixture://f06-resumes?scale=0.05'), 'bad.json': resumeScenario('fixture://f06-skips?scale=0.05') }
        const json = host(files)
        await main(['test', 'ok.json', 'bad.json', '--format', 'json'], json.io)
        const parsed = JSON.parse(json.out)
        expect(parsed.scenarios.map((s: { status: string }) => s.status)).toEqual(['pass', 'fail'])
        const junit = host(files)
        await main(['test', 'ok.json', 'bad.json', '--format', 'junit'], junit.io)
        expect(junit.out.match(/<testsuite /g)).toHaveLength(2)
        expect(junit.out).toContain('<failure')
        const md = host(files)
        await main(['test', 'bad.json', '--format', 'md'], md.io)
        expect(md.out).toContain('| resume | FAIL |')
    })

    it('rejects an invalid scenario with the place of the mistake, and a literal secret, with exit 2', async () => {
        const invalid = host({ 'i.json': '{ "version": 1, "name": "x", "steps": [] ' })
        expect(await main(['test', 'i.json'], invalid.io)).toBe(EXIT.usage)
        expect(invalid.err).toMatch(/line \d/)
        const literal = host({ 'l.json': JSON.stringify({ version: 1, name: 'x', target: { url: 'https://x.test/s', headers: { Authorization: 'Bearer abcdefghijklmnop1234' } }, steps: [{ wait: { ms: 1 } }] }) })
        expect(await main(['test', 'l.json'], literal.io)).toBe(EXIT.usage)
        expect(literal.err).not.toContain('abcdefghijklmnop1234')
        expect(await main(['test'], host().io)).toBe(EXIT.usage)
        expect(await main(['test', 'missing.json'], host().io)).toBe(EXIT.couldNotRun)
    })
})

describe('replay target and command', () => {
    let fixtures: FixtureServer
    beforeAll(async () => { fixtures = await startFixtureServer({ port: 0 }) })
    afterAll(async () => { await fixtures.close() })


    it('fills ${ENV:NAME} from the environment, names the variables that are missing, and scrubs the values from output', async () => {
        const text = JSON.stringify({ version: 1, name: 'env', target: { url: '${ENV:STREAM_URL}', headers: { Authorization: '${ENV:AUTH}' } }, steps: [{ collect_events: 1, timeout_ms: 10000 }] })
        const missing = host({ 'e.json': text }, {})
        expect(await main(['test', 'e.json'], missing.io)).toBe(EXIT.usage)
        expect(missing.err).toMatch(/not set: (AUTH, STREAM_URL|STREAM_URL, AUTH)/)
        const url = fixtures.urlFor('f08-token', { scale: 0.05, n: 2, token: 'canary-tok-4411' })
        const h = host({ 'e.json': text }, { STREAM_URL: url, AUTH: 'Bearer canary-auth-9902' })
        expect([EXIT.ok, EXIT.gateFailed]).toContain(await main(['test', 'e.json', '--format', 'json', '--output', 'r.json'], h.io))
        expect(h.all()).not.toContain('canary-tok-4411')
        expect(h.all()).not.toContain('canary-auth-9902')
    })

    it('a scenario can run against a capture, and a test aid that drops an id makes it fail', async () => {
        const original = await observeFixture(fixtures, defaultRules, 'f06-resumes', {}, true, { captureBytes: true })
        const file = serializeCapture(original.capture)
        const scenario = (replay: Record<string, unknown>) => JSON.stringify({
            version: 1, name: 'replayed', target: { replay: { capture: 'c.sse-capture', ...replay }, sequence: contract },
            steps: [{ collect_events: 4, timeout_ms: 10000 }, { disconnect: { mode: 'server' } }, { reconnect: { after_ms: 0 } }, { collect_events: 3, timeout_ms: 10000 }],
            verify: ['no_unexplained_sequence_gaps'],
        })
        const ok = host({ 'c.sse-capture': file, 's.json': scenario({}) })
        expect(await main(['test', 's.json'], ok.io)).toBe(EXIT.ok)
        const skipped = host({ 'c.sse-capture': file, 's.json': scenario({ honor_last_event_id: true, test_aids: { skip_ids: ['6'] } }) })
        expect(await main(['test', 's.json'], skipped.io)).toBe(EXIT.gateFailed)
    })

    it('replay serves a capture until interrupted', async () => {
        const original = await observeFixture(fixtures, defaultRules, 'f09-healthy', {}, false, { captureBytes: true })
        const controller = new AbortController()
        const h = host({ 'c.sse-capture': serializeCapture(original.capture) }, {}, controller.signal)
        const running = main(['replay', 'c.sse-capture', '--speed', '100'], h.io)
        await new Promise((r) => setTimeout(r, 100))
        const url = /http:\/\/127\.0\.0\.1:\d+\//.exec(h.out)![0]
        const body = await (await fetch(url)).text()
        expect(body).toContain('id: 1')
        controller.abort()
        expect(await running).toBe(EXIT.interrupted)
    })

    it('replay and fixtures refuse bad input', async () => {
        expect(await main(['replay'], host().io)).toBe(EXIT.usage)
        expect(await main(['replay', 'c', '--end', 'explode'], host({ c: serializeCapture({ header: (await observeFixture(fixtures, defaultRules, 'h01', { n: 1 }, false, { captureBytes: true })).capture.header, records: [] }) }).io)).toBe(EXIT.usage)
        const list = host()
        expect(await main(['fixtures', 'list'], list.io)).toBe(EXIT.ok)
        expect(list.out).toContain('f06-skips')
        expect(await main(['fixtures', 'bogus'], host().io)).toBe(EXIT.usage)
    })
})
