import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { main, EXIT, type CliIo } from '../index'
import { loadReplaySession } from '../replaySource'
import { parseCapture, serializeCapture, type CaptureRecord } from '../../core/capture/format'
import { localCapture } from '../../core/capture/build'
import { redactCapture } from '../../core/capture/redact'
import { healthyStart } from '../../core/testing/captureBuilder'
import { defaultRules } from '../../core/diagnostics/rules'
import { startFixtureServer, type FixtureServer } from '../../fixtures/server'
import { observeFixture } from '../../fixtures/__tests__/observeFixture'
import { planReplay } from '../../../lib/mock/capturePlan.js'

// Q-I1 (decided by the owner): a capture exported by the app holds what happened on the wire, not what the events said, so it has no
// payload. `sse-doctor replay` makes a labelled placeholder copy IN MEMORY (the same function the app's Replay button uses), preserves ids,
// names, order and timing, and says it is a SYNTHETIC replay, not a byte-exact one. A capture that holds payload replays as before.

/** What the app exports: a redacted capture, chunk records with sizes only, events with sizes and no body. */
function appExport(): string {
    const b = healthyStart().silence(100).frame('tick', '1', 40).silence(150).frame('tick', '2', 60).silence(450).frame('other', '3', 25)
    const records = (b.observations() as CaptureRecord[]).map((r) => (r.kind === 'event' ? { ...r, extracted: { seq: Number((r as { sseId: string }).sseId) } } : r)) as CaptureRecord[]
    const full = localCapture(records, { source: { kind: 'browser-app' }, request: { url: 'https://stream.test/e' } })
    return serializeCapture(redactCapture(full).capture)
}

function host(files: Record<string, string>, signal?: AbortSignal) {
    const written: Record<string, string> = {}
    let out = ''
    let err = ''
    const io: CliIo = {
        out: (t) => { out += t }, err: (t) => { err += t },
        readText: async (p) => { if (p in files) return files[p]!; throw new Error('ENOENT') },
        writeText: async (p, t) => { written[p] = t },
        env: {}, ...(signal ? { signal } : {}),
    }
    return { io, written, get out() { return out }, get err() { return err } }
}

/** Starts `replay` on `files['c']` and returns what a client sees on its first request. */
async function serveAndFetch(files: Record<string, string>, extra: string[] = []) {
    const controller = new AbortController()
    const h = host(files, controller.signal)
    const running = main(['replay', 'c', '--speed', '100', ...extra], h.io)
    const started = Date.now()
    let url = ''
    while (!url && Date.now() - started < 5000) {
        url = /http:\/\/127\.0\.0\.1:\d+\//.exec(h.out)?.[0] ?? ''
        if (!url) await new Promise((r) => setTimeout(r, 10))
        if (!url && h.err.includes('"c"')) break
    }
    if (!url) { controller.abort(); return { code: await running, h, url, body: '', headers: new Headers() } }
    const res = await fetch(url)
    const body = await res.text()
    controller.abort()
    return { code: await running, h, url, body, headers: res.headers }
}

describe('replay of a capture the app exported (no payload): a synthetic replay', () => {
    it('is refused today and replayed now, with the ids, names, order and sizes of the recording, and labelled synthetic in the notice, on stdout and on the wire', async () => {
        const text = appExport()
        const { code, h, body, headers } = await serveAndFetch({ c: text })
        expect(code).toBe(EXIT.interrupted)
        expect(h.err).toMatch(/note: .*synthetic replay.*not byte-exact/i)
        expect(h.err).toContain('3 event bodies')
        expect(h.out).toMatch(/synthetic replay, not byte-exact/i)
        expect(headers.get('x-mock-synthetic')).toBe('placeholder-bodies')
        const frames = body.split('\n\n').filter(Boolean).map((f) => f.split('\n'))
        expect(frames.map((f) => f.filter((l) => !l.startsWith('data:')))).toEqual([['id: 1', 'event: tick'], ['id: 2', 'event: tick'], ['id: 3', 'event: other']])
        const sizes = frames.map((f) => f.find((l) => l.startsWith('data: '))!.slice(6).length)
        expect(sizes, 'each body has the recorded size').toEqual([40, 60, 25])
        for (const f of frames) expect(() => JSON.parse(f.find((l) => l.startsWith('data: '))!.slice(6))).not.toThrow()
    })

    it('keeps the timing of the recording: the gaps between the events are the capture\'s', async () => {
        const text = appExport()
        const loaded = loadReplaySession(text)
        expect(loaded.error).toBeUndefined()
        const original = parseCapture(text).capture.records.filter((r) => r.kind === 'event')
        const steps = planReplay(loaded.session).steps
        expect(steps.map((s: { atMs: number }) => s.atMs)).toEqual(original.map((r) => r.t - original[0]!.t))
        expect(steps.map((s: { atMs: number }) => s.atMs)).toEqual([0, 150, 600])
    })

    it('never changes the file: its bytes are the same after, nothing is written, and the copy exists only in memory', async () => {
        const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'sse-synthetic-'))
        try {
            const file = path.join(folder, 'app.sse-capture')
            fs.writeFileSync(file, appExport())
            const before = crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex')
            const controller = new AbortController()
            let out = ''
            let err = ''
            let writes = 0
            const io: CliIo = { out: (t) => { out += t }, err: (t) => { err += t }, readText: async (p) => fs.readFileSync(p, 'utf8'), writeText: async () => { writes++ }, env: {}, signal: controller.signal }
            const running = main(['replay', file, '--speed', '100'], io)
            const until = Date.now() + 4000
            while (!/http:\/\/127\.0\.0\.1:\d+\//.test(out) && Date.now() < until) await new Promise((r) => setTimeout(r, 10))
            expect(out, 'the replay started').toMatch(/http:\/\/127\.0\.0\.1:\d+\//)
            await (await fetch(/http:\/\/127\.0\.0\.1:\d+\//.exec(out)![0])).text()
            controller.abort()
            expect(await running).toBe(EXIT.interrupted)
            expect(err).toMatch(/synthetic/i)
            expect(writes).toBe(0)
            expect(crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex')).toBe(before)
            expect(fs.readdirSync(folder)).toEqual(['app.sse-capture'])
            const reread = parseCapture(fs.readFileSync(file, 'utf8')).capture
            expect(reread.header.source.synthetic, 'the original is not marked synthetic').toBeUndefined()
            expect(reread.records.some((r) => r.kind === 'event' && 'data' in r), 'and has no invented body').toBe(false)
        } finally { fs.rmSync(folder, { recursive: true, force: true }) }
    })

    it('uses the smallest valid body for an event whose size was not recorded, and says how many', async () => {
        const records = (healthyStart().frame('tick', '1', 40).frame('tick', '2').observations() as CaptureRecord[]).map((r) => {
            if (r.kind !== 'event' || (r as { sseId: string }).sseId !== '2') return r
            const { dataBytes: _ignored, ...rest } = r as unknown as Record<string, unknown>
            return rest as unknown as CaptureRecord
        })
        const text = serializeCapture(localCapture(records, { source: { kind: 'browser-app' } }))
        const { code, h, body } = await serveAndFetch({ c: text })
        expect(code).toBe(EXIT.interrupted)
        expect(h.err).toMatch(/1 (event )?(has|have) no recorded size/i)
        expect(body).toContain('id: 2\nevent: tick\ndata: {}\n\n')
    })
})

describe('replay of a capture that holds payload is exact, and carries no label', () => {
    let fixtures: FixtureServer
    beforeAll(async () => { fixtures = await startFixtureServer({ port: 0 }) })
    afterAll(async () => { await fixtures.close() })

    it('serves the recorded bytes (chunk-faithful) with no synthetic note, line or header', async () => {
        const original = await observeFixture(fixtures, defaultRules, 'f09-healthy', {}, false, { captureBytes: true })
        const { code, h, body, headers } = await serveAndFetch({ c: serializeCapture(original.capture) })
        expect(code).toBe(EXIT.interrupted)
        expect(body).toContain('id: 1')
        expect(h.err).not.toMatch(/synthetic/i)
        expect(h.out).not.toMatch(/synthetic/i)
        expect(headers.get('x-mock-synthetic')).toBeNull()
        expect(headers.get('x-mock-fidelity')).toBe('chunk-faithful')
    })

    it('a capture with event bodies and no wire bytes (an imported v1 recording) is event-level and unlabelled', async () => {
        const records = (healthyStart().frame('tick', '1').frame('tick', '2').observations() as CaptureRecord[]).map((r) => (r.kind === 'event' ? { ...r, data: '{"real":true}' } : r))
        const text = serializeCapture(localCapture(records, { source: { kind: 'import-v1', synthetic: true } }))
        const { code, h, body } = await serveAndFetch({ c: text })
        expect(code).toBe(EXIT.interrupted)
        expect(body).toContain('data: {"real":true}')
        expect(h.err).not.toMatch(/synthetic replay/i)
    })
})

describe('what is still refused, with a message and exit 2, never a crash', () => {
    const run = async (text: string) => { const h = host({ c: text }); const code = await main(['replay', 'c'], h.io); return { code, err: h.err, out: h.out } }
    const records = (build: (b: ReturnType<typeof healthyStart>) => ReturnType<typeof healthyStart>) => build(healthyStart()).observations() as CaptureRecord[]
    const asFile = (rs: CaptureRecord[]) => serializeCapture(localCapture(rs, { source: { kind: 'browser-app' } }))

    it('a capture with no size metadata at all (events without a recorded size)', async () => {
        const stripped = records((b) => b.frame('tick', '1').frame('tick', '2')).map((r) => { const { dataBytes: _d, ...rest } = r as unknown as Record<string, unknown>; return r.kind === 'event' ? (rest as unknown as CaptureRecord) : r })
        const r = await run(asFile(stripped))
        expect(r.code).toBe(EXIT.usage)
        expect(r.err).toMatch(/no payload/i)
        expect(r.err).toMatch(/no size|size/i)
        expect(r.err).not.toMatch(/\bat .*\.(js|ts):\d+/)
        expect(r.out).toBe('')
    })

    it('a capture with no events at all (only chunks and sizes)', async () => {
        const r = await run(asFile(records((b) => b.chunk(100).chunk(100))))
        expect(r.code).toBe(EXIT.usage)
        expect(r.err).toMatch(/no payload/i)
        expect(r.err).toMatch(/no events/i)
    })

    it('sizes too large to build a body from', async () => {
        const huge = records((b) => b.frame('tick', '1')).map((r) => (r.kind === 'event' ? ({ ...r, dataBytes: 1e12 } as CaptureRecord) : r))
        const r = await run(asFile(huge))
        expect(r.code).toBe(EXIT.usage)
        expect(r.err).toMatch(/too large/i)
    })

    it('a damaged file: not a capture, a cut line in the middle, a wrong version', async () => {
        const good = appExport().split('\n')
        for (const text of ['not json at all', '', good.slice(0, 3).join('\n') + '\n{"kind":"chu\n' + good.slice(3).join('\n'), good[0]!.replace('"2.0"', '"9.0"') + '\n' + good.slice(1).join('\n')]) {
            const r = await run(text)
            expect(r.code, JSON.stringify(text.slice(0, 40))).toBe(EXIT.usage)
            expect(r.err).toContain('"c"')
            expect(r.err).not.toMatch(/\bat .*\.(js|ts):\d+/)
        }
    })

    it('an unreadable file is exit 3, as before', async () => {
        const h = host({})
        expect(await main(['replay', 'missing'], h.io)).toBe(EXIT.couldNotRun)
    })
})
