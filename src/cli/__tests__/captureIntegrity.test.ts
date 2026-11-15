import fs from 'node:fs'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { analyze } from '../../core/diagnostics/engine'
import type { Observation } from '../../core/observe/observation'
import { parseCapture, serializeCapture, type CaptureRecord } from '../../core/capture/format'
import { startFixtureServer, type FixtureServer } from '../../fixtures/server'
import { EXIT, main, type CliIo } from '../index'

// Owner decision: a duplicate `seq` or a backwards `t` in a capture file must not pass as healthy. Every command that reads a capture refuses
// such a file with the existing "invalid input" exit code (2) and says what is wrong and where. Nothing is analysed, so there is no verdict.

const lab = (id: string) => fs.readFileSync(path.resolve(process.cwd(), `public/lab/${id}.sse-capture`), 'utf8')

function host(files: Record<string, string>) {
    let out = ''
    let err = ''
    const io: CliIo = { out: (t) => { out += t }, err: (t) => { err += t }, readText: async (p) => { if (p in files) return files[p]!; throw new Error('ENOENT') }, writeText: async () => undefined }
    return { io, get out() { return out }, get err() { return err } }
}

/** A healthy lab capture, with one record changed. The integrity hash is rewritten by the serializer, so the file is intact as a file. */
function damaged(id: string, change: (records: CaptureRecord[]) => void): string {
    const parsed = parseCapture(lab(id))
    const records = parsed.capture.records.map((r) => ({ ...r }))
    change(records)
    return serializeCapture({ ...parsed.capture, records })
}

const lineOfRecord = (text: string, index: number) => index + 2 // header is line 1, the records follow one per line

describe('a capture the analysis used to call healthy', () => {
    it('h01 with one time pulled back: the engine alone finds nothing (which is why the file must be refused before it gets there)', () => {
        const records = parseCapture(lab('h01')).capture.records.map((r) => ({ ...r }))
        records[5]!.t = records[4]!.t - 1
        expect(analyze(records as Observation[]).findings.filter((f) => f.severity !== 'info')).toEqual([])
    })
})

describe('analyze', () => {
    it('a duplicate seq: exit 2, the diagnostic on stderr says which seq and which line, and stdout holds no verdict', async () => {
        const text = damaged('h01', (r) => { r[3]!.seq = r[2]!.seq })
        const h = host({ 'dup.sse-capture': text })
        expect(await main(['analyze', 'dup.sse-capture'], h.io)).toBe(EXIT.usage)
        expect(h.out).toBe('')
        expect(h.err).toMatch(/^"dup\.sse-capture": Invalid capture: 1 problem in its records\./)
        expect(h.err).toContain(`seq 2 is used twice: line ${lineOfRecord(text, 3)} repeats the seq of line ${lineOfRecord(text, 2)}`)
        expect(h.err).toMatch(/not analysed/)
        expect(h.err).not.toMatch(/healthy|No findings/i)
    })

    it('a time that goes backwards: exit 2, names the seq and both times', async () => {
        const text = damaged('h01', (r) => { r[5]!.t = r[4]!.t - 1 })
        const h = host({ 'back.sse-capture': text })
        expect(await main(['analyze', 'back.sse-capture'], h.io)).toBe(EXIT.usage)
        expect(h.out).toBe('')
        expect(h.err).toMatch(/time goes backwards at seq 5 \(line 7\): t=\S+ ms follows t=\S+ ms \(seq 4, line 6\)/)
    })

    it('several problems: the first ones are listed and the rest counted', async () => {
        const text = damaged('h01', (r) => { for (let i = 2; i < 9; i++) r[i]!.t = 1e6 - i * 1000 })
        const h = host({ 'many.sse-capture': text })
        expect(await main(['analyze', 'many.sse-capture'], h.io)).toBe(EXIT.usage)
        expect(h.err).toMatch(/Invalid capture: 7 problems/)
        expect((h.err.match(/^ {2}- /gm) ?? []).length).toBe(6) // five listed, plus "and 2 more"
        expect(h.err).toMatch(/and 2 more/)
    })

    it('--format json, --quiet and --fail-on change nothing: no JSON document is written for a file that was not analysed (the schema describes findings, and there are none to give)', async () => {
        const text = damaged('h01', (r) => { r[3]!.seq = r[2]!.seq })
        for (const extra of [['--format', 'json'], ['--quiet'], ['--fail-on', 'critical'], ['--format', 'junit'], ['--format', 'md']]) {
            const h = host({ 'dup.sse-capture': text })
            expect(await main(['analyze', 'dup.sse-capture', ...extra], h.io), extra.join(' ')).toBe(EXIT.usage)
            expect(h.out, extra.join(' ')).toBe('')
            expect(h.err, extra.join(' ')).toMatch(/Invalid capture/)
        }
    })

    it('a healthy capture is unaffected: same exit code, a verdict on stdout, nothing on stderr', async () => {
        const h = host({ 'h01.sse-capture': lab('h01') })
        expect(await main(['analyze', 'h01.sse-capture'], h.io)).toBe(EXIT.ok)
        expect(h.out).toMatch(/No findings\./)
        expect(h.err).toBe('')
        const f = host({ 'f.sse-capture': lab('f04-silent') })
        expect(await main(['analyze', 'f.sse-capture'], f.io)).toBe(EXIT.gateFailed)
    })

    it('equal times and a seq that does not start at 0 are legal: the file is analysed', async () => {
        const text = damaged('h01', (r) => { r.forEach((x, i) => { x.seq = 100 + i }); r[4]!.t = r[3]!.t })
        const h = host({ 'ok.sse-capture': text })
        expect(await main(['analyze', 'ok.sse-capture'], h.io), h.err).toBe(EXIT.ok)
    })
})

describe('every other command that reads a capture refuses it the same way', () => {
    const text = damaged('h01', (r) => { r[3]!.seq = r[2]!.seq })
    const argvs: string[][] = [
        ['report', 'bad.sse-capture', '--redact'],
        ['redact', 'bad.sse-capture', '--output', 'out.sse-capture'],
        ['compare', 'h01.sse-capture', 'bad.sse-capture'],
        ['compare', 'bad.sse-capture', 'h01.sse-capture'],
        ['repro', 'bad.sse-capture', '--output', 'min.sse-capture'],
        ['curl', 'bad.sse-capture', '--redact'],
        ['validate', 'bad.sse-capture', 'http://127.0.0.1:9/'], // refused before any connection is made
    ]
    it.each(argvs)('%s', async (...argv) => {
        const h = host({ 'bad.sse-capture': text, 'h01.sse-capture': lab('h01') })
        expect(await main(argv, h.io)).toBe(EXIT.usage)
        expect(h.out).toBe('')
        expect(h.err).toMatch(/bad\.sse-capture": Invalid capture: 1 problem/)
        expect(h.err).toContain('seq 2 is used twice')
    })

    it('replay refuses it (it reads the file for the mock server, not through the reader above)', async () => {
        const h = host({ 'bad.sse-capture': text })
        expect(await main(['replay', 'bad.sse-capture', '--port', '0'], h.io)).toBe(EXIT.usage)
        expect(h.out).toBe('')
        expect(h.err).toMatch(/bad\.sse-capture": Invalid capture: 1 problem/)
        expect(h.err).toContain('seq 2 is used twice: line')
    })
})

describe('captures the command line itself writes are never refused (a recorder numbers records from one counter and clamps t)', () => {
    let fixtures: FixtureServer
    beforeAll(async () => { fixtures = await startFixtureServer({ port: 0 }) })
    afterAll(async () => { await fixtures.close() })

    // f05-drops reconnects several times inside one capture (conn 0, 1, 2, ...), f06-skips resumes with Last-Event-ID
    it.each(['h01', 'f05-drops', 'f06-skips'])('probe %s --out, then analyze that file: valid, every connection in order', async (id) => {
        const files: Record<string, string> = {}
        let err = ''
        const io: CliIo = { out: () => undefined, err: (t) => { err += t }, readText: async (p) => { if (p in files) return files[p]!; throw new Error('ENOENT') }, writeText: async (p, t) => { files[p] = t }, writeRawText: async (p, t) => { files[p] = t }, env: {} }
        await main(['probe', fixtures.urlFor(id, { scale: 0.05 }), '--duration', '8', '--out', 'p.sse-capture'], io)
        const parsed = parseCapture(files['p.sse-capture']!)
        expect(parsed.problems, err).toEqual([])
        expect(new Set(parsed.capture.records.map((r) => r.conn)).size, `${id} has more than one connection`).toBeGreaterThanOrEqual(id === 'h01' ? 1 : 2)
        const again = host({ 'p.sse-capture': files['p.sse-capture']! })
        expect([EXIT.ok, EXIT.gateFailed]).toContain(await main(['analyze', 'p.sse-capture'], again.io))
        expect(again.err).not.toMatch(/Invalid capture/)
    })
})
