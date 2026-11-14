import fs from 'node:fs'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { main, EXIT, type CliIo } from '../index'
import { startFixtureServer, type FixtureServer } from '../../fixtures/server'

// "Did the fix work?" against the captures that ship in the failure lab and the built-in streams: a capture that showed a bug, and a stream
// that has the bug or has been fixed.

const lab = (id: string) => fs.readFileSync(path.resolve(process.cwd(), `public/lab/${id}.sse-capture`), 'utf8')

function host(files: Record<string, string> = {}, env: Record<string, string> = {}) {
    let out = ''
    let err = ''
    const io: CliIo = {
        out: (t) => { out += t }, err: (t) => { err += t },
        readText: async (p) => { if (p in files) return files[p]!; throw new Error('ENOENT') },
        writeText: async () => {},
        env,
    }
    return { io, get out() { return out }, get err() { return err } }
}

let fixtures: FixtureServer
beforeAll(async () => { fixtures = await startFixtureServer({ port: 0 }) })
afterAll(async () => { await fixtures.close() })

const url = (id: string) => fixtures.urlFor(id, { scale: 0.05 })

describe('validate', () => {
    it('fixed: the finding the capture showed is gone from the stream, and the check that raises it ran', async () => {
        const h = host({ 'bug.sse-capture': lab('f06-skips') })
        const code = await main(['validate', 'bug.sse-capture', url('f06-resumes'), '--finding', 'resume.last-event-id:skipped'], h.io)
        expect(h.out).toContain('Verdict: Fixed, as far as this reading shows')
        expect(code).toBe(EXIT.ok)
        expect(h.out).toContain('sse-doctor repro <capture> --scenario <file>')
        expect(h.out).toContain('One reading is not proof')
    })

    it('not fixed: the same finding is reported again, and the exit code says so', async () => {
        const h = host({ 'bug.sse-capture': lab('f06-skips') })
        const code = await main(['validate', 'bug.sse-capture', url('f06-skips'), '--finding', 'resume.last-event-id:skipped'], h.io)
        expect(h.out).toContain('Verdict: Not fixed: "resume.last-event-id:skipped" is reported again')
        expect(code).toBe(EXIT.gateFailed)
    })

    it('chooses the most serious finding when none is named, and says which', async () => {
        const h = host({ 'bug.sse-capture': lab('f06-skips') })
        await main(['validate', 'bug.sse-capture', url('f06-resumes')], h.io)
        expect(h.out).toMatch(/The capture reported "resume\.last-event-id:skipped" \((warning|error)\)/)
    })

    it('reads the stream the way the capture was read: with the capture\'s own profile, so a sequence is still judged', async () => {
        // f06's profile declares the sequence; without it the check would not run and the verdict could not be "fixed"
        const h = host({ 'bug.sse-capture': lab('f06-skips') })
        expect(await main(['validate', 'bug.sse-capture', url('f06-resumes'), '--finding', 'resume.last-event-id:skipped'], h.io)).toBe(EXIT.ok)
        expect(h.out).not.toContain('Inconclusive')
    })

    it('inconclusive, not fixed, when the stream is read under a different profile than the capture was: a check that needs a declared sequence cannot run', async () => {
        // read the fixed stream with a profile that does not declare the sequence the capture was judged with: the "skipped events" check
        // cannot judge, so its silence would look like a fix
        const h = host({ 'bug.sse-capture': lab('f06-skips'), 'none.json': '{"delivery":"at_least_once"}' })
        const code = await main(['validate', 'bug.sse-capture', url('f06-resumes'), '--finding', 'resume.last-event-id:skipped', '--profile', 'none.json'], h.io)
        expect(h.out).toContain('Verdict: Inconclusive')
        expect(h.out).toContain('judged under a different profile than the capture')
        expect(h.out).toContain('does not show the fix worked')
        expect(code).toBe(EXIT.inconclusive)
    })

    it('is a usage error when the capture does not show the finding it was asked about, naming what it does show', async () => {
        const h = host({ 'bug.sse-capture': lab('f06-skips') })
        expect(await main(['validate', 'bug.sse-capture', url('f06-resumes'), '--finding', 'nope.never'], h.io)).toBe(EXIT.usage)
        expect(h.err).toContain('does not report "nope.never"')
        expect(h.err).toContain('resume.last-event-id')
    })

    it('is a usage error when the capture reports nothing at all', async () => {
        const h = host({ 'ok.sse-capture': lab('h01') })
        expect(await main(['validate', 'ok.sse-capture', url('h01')], h.io)).toBe(EXIT.usage)
        expect(h.err).toContain('reports no finding')
    })

    it('could not run when the stream never answers, whatever the capture showed', async () => {
        const h = host({ 'bug.sse-capture': lab('f06-skips') })
        const code = await main(['validate', 'bug.sse-capture', 'http://127.0.0.1:9/none', '--finding', 'resume.last-event-id:skipped', '--duration', '3'], h.io)
        expect(code).toBe(EXIT.couldNotRun)
        expect(h.out).toContain('the stream never answered')
    }, 30_000)

    it('inconclusive, not fixed, when the finding is gone only because the check that raises it could not run (no events were read to judge a silence in)', async () => {
        const h = host({ 'bug.sse-capture': lab('f04-silent') })
        const code = await main(['validate', 'bug.sse-capture', url('f01-404'), '--finding', 'stall.silent:bytes', '--duration', '5'], h.io)
        expect(h.out).toContain('Verdict: Inconclusive')
        expect(h.out).toContain('could not run on this reading')
        expect(code).toBe(EXIT.inconclusive)
    }, 30_000)

    it('lists what else the reading found, without judging it', async () => {
        const h = host({ 'bug.sse-capture': lab('f04-silent') })
        await main(['validate', 'bug.sse-capture', url('f01-text-html'), '--finding', 'stall.silent:bytes', '--duration', '5'], h.io)
        expect(h.out).toMatch(/also reports, about other checks: .*proto\.content-type/)
        expect(h.out).toContain('They are not judged here')
    }, 30_000)

    it('needs a capture and a URL', async () => {
        for (const argv of [['validate'], ['validate', 'x.sse-capture'], ['validate', 'x.sse-capture', 'ftp://nope']]) {
            const h = host({ 'x.sse-capture': lab('f06-skips') })
            expect(await main(argv, h.io), argv.join(' ')).toBe(EXIT.usage)
            expect(h.err).toContain('Usage: sse-doctor validate')
        }
    })
})
