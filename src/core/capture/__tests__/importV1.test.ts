import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { analyze } from '../../diagnostics/engine'
import type { Observation } from '../../observe/observation'
import { parseCapture, serializeCapture } from '../format'
import { importV1, isV1Recording, V1ImportError } from '../importV1'
import { framesOf } from '../streamText'
import { loadCaptureText } from '../../../doctor/loadCapture'
import { EXIT, main, type CliIo } from '../../../cli/index'
import { replay, validateSession } from '../../../../lib/mock/session.js'

// Plan D6: recordings made by the v1 app (.sse-record) must keep importing.
//
// What is NOT here, and is still needed: real exports. The plan asks for three or four small files exported by the v1.0.0 app. None exists in the
// repository or on this machine. The files in ./v1Samples were instead produced by running the v1.0.0 export code path (buildEvent -> createRecording
// -> JSON.stringify(_, null, 2), as exportUtils does; replayUtils.ts is byte-identical between v1.0.0 and now) on events built to cover the shapes an
// export can take. They have the real field set (internal uuid id, timestamp, arrivalTime, seq, type, data, raw, sseId, parsedType, deltaMs) but they
// were never downloaded from the running app, so they cannot show a field the export code does not write (a browser quirk, a hand edit, an older build).
// Replace or add to them with real downloads when somebody has them.

const SAMPLES = ['steady-5', 'named-unicode-multiline', 'empty', 'plain-text-long-gap'] as const
const read = (name: string): string => readFileSync(new URL(`./v1Samples/${name}.sse-record`, import.meta.url), 'utf8')

interface RawEvent { id: string; type: string; data: string; sseId?: string; deltaMs: number; [k: string]: unknown }
const rawOf = (name: string) => JSON.parse(read(name)) as { version: string; totalEvents: number; durationMs: number; events: RawEvent[] }

function host(files: Record<string, string>) {
    let out = ''
    let err = ''
    const io: CliIo = { out: (t) => { out += t }, err: (t) => { err += t }, readText: async (p) => { if (p in files) return files[p]!; throw new Error('ENOENT') }, writeText: async () => undefined }
    return { io, get out() { return out }, get err() { return err } }
}
const utf8 = (s: string) => new TextEncoder().encode(s).length

describe('v1 samples (made by the v1.0.0 export code; see the note at the top)', () => {
    it('are what they claim to be: version 1.0, pretty-printed, with the fields of a v1 export', () => {
        for (const name of SAMPLES) {
            const text = read(name)
            expect(text.startsWith('{\n  "version": "1.0"'), name).toBe(true)
            const raw = rawOf(name)
            expect(raw.totalEvents, name).toBe(raw.events.length)
            expect(isV1Recording(raw), name).toBe(true)
            for (const e of raw.events) expect(Object.keys(e)).toEqual(expect.arrayContaining(['id', 'timestamp', 'arrivalTime', 'seq', 'type', 'data', 'raw', 'deltaMs']))
        }
        expect(rawOf('named-unicode-multiline').events.some((e) => e.sseId === undefined)).toBe(true) // an event the server sent without an id
        expect(rawOf('empty').events).toEqual([])
    })

    it.each(SAMPLES)('%s imports to a capture that holds exactly what the file holds, with a rebuilt timeline', (name) => {
        const raw = rawOf(name)
        const capture = importV1(JSON.parse(read(name)))
        expect(capture.header.source).toEqual({ kind: 'import-v1', synthetic: true })
        expect(capture.header.kind).toBe('local-full')
        expect(capture.footer).toEqual({ endReason: 'import', counts: { event: raw.events.length } })
        expect(capture.records).toHaveLength(raw.events.length)
        // the oracle is the file: times are the running sum of the gaps, and each record is the event it came from
        let t = 0
        raw.events.forEach((e, i) => {
            t += e.deltaMs
            expect(capture.records[i], `${name} #${i}`).toEqual({ seq: i, t, conn: 0, kind: 'event', event: e.type, sseId: e.sseId ?? '', dataBytes: utf8(e.data), data: e.data })
        })
        expect(raw.events.length === 0 ? 0 : t).toBe(raw.durationMs) // the file's own total agrees with the times
    })

    it.each(SAMPLES)('%s: the payload comes back as the frames a stream of these events would have carried, and survives a write and a read', (name) => {
        const raw = rawOf(name)
        const capture = importV1(JSON.parse(read(name)))
        expect(framesOf(capture).map((f) => [f.id, f.event, f.data])).toEqual(raw.events.map((e) => [e.sseId ?? '', e.type, e.data]))
        const parsed = parseCapture(serializeCapture(capture))
        expect(parsed.integrity).toBe('ok')
        expect(parsed.warnings).toEqual([])
        expect(parsed.capture.records).toEqual(capture.records)
        expect(parsed.capture.header.source).toEqual(capture.header.source)
    })

    it('multi-line data and a heartbeat with empty data keep their shape (they are the cases a line-based reader gets wrong)', () => {
        const events = importV1(JSON.parse(read('named-unicode-multiline'))).records as Array<{ data: string; event: string; dataBytes: number }>
        expect(events[1]!.data).toBe('line one\nline two\n\nline four')
        expect(events[2]).toMatchObject({ event: 'heartbeat', data: '', dataBytes: 0 })
        expect(events[3]).toMatchObject({ event: 'message', data: '日本語 ✓ emoji 😀' })
        expect(events[3]!.dataBytes).toBe(utf8('日本語 ✓ emoji 😀')) // bytes, not characters
        expect(events[3]!.dataBytes).toBeGreaterThan(events[3]!.data.length)
    })

    it('a long gap stays a long gap: 90 seconds, not clamped', () => {
        expect(importV1(JSON.parse(read('plain-text-long-gap'))).records.map((r) => r.t)).toEqual([0, 90_000])
    })
})

describe('through the CLI', () => {
    it.each(SAMPLES)('analyze %s exits 0, says it imported an old recording, and lists what it could not evaluate instead of calling it healthy', async (name) => {
        const h = host({ 'x.sse-record': read(name) })
        expect(await main(['analyze', 'x.sse-record'], h.io)).toBe(EXIT.ok)
        expect(h.out).toContain('Imported an old .sse-record')
        expect(h.out).toContain('Not evaluated (this is not the same as healthy)')
        expect(h.err).toBe('')
    })

    it('every command that reads a capture reads a recording', async () => {
        const files = { 'x.sse-record': read('steady-5'), 'y.sse-record': read('named-unicode-multiline') }
        for (const argv of [['analyze', 'x.sse-record', '--format', 'json'], ['compare', 'x.sse-record', 'y.sse-record'], ['report', 'x.sse-record', '--redact']]) {
            const h = host({ ...files })
            const code = await main(argv, h.io)
            expect([EXIT.ok, EXIT.gateFailed], `${argv.join(' ')}: ${h.err}`).toContain(code)
            expect(h.err).not.toMatch(/could not finish/)
        }
    })

    it('the same file as the Doctor opens it (a person drops it on the Captures tab) gives the same capture', () => {
        const loaded = loadCaptureText(read('named-unicode-multiline'))
        expect(loaded.ok).toBe(true)
        if (!loaded.ok) return
        expect(loaded.format).toBe('sse-record')
        expect(loaded.capture.records).toEqual(importV1(JSON.parse(read('named-unicode-multiline'))).records)
    })

    it('a recording with a byte order mark, as an editor or a PowerShell redirect writes it, opens in the CLI as it does in the Doctor', async () => {
        const text = '﻿' + read('steady-5')
        expect(loadCaptureText(text).ok, 'the Doctor reads it').toBe(true)
        const h = host({ 'bom.sse-record': text })
        expect(await main(['analyze', 'bom.sse-record'], h.io), h.err).toBe(EXIT.ok)
        expect(h.out).toContain('Imported an old .sse-record')
    })

    it('with Windows line endings it opens too', async () => {
        const text = read('steady-5').replace(/\n/g, '\r\n')
        const h = host({ 'crlf.sse-record': text })
        expect(await main(['analyze', 'crlf.sse-record'], h.io), h.err).toBe(EXIT.ok)
        expect(h.out).toContain('Imported an old .sse-record')
    })

    it('a recording that is not valid JSON, is cut off, or is a v2 capture header alone, is refused with exit 2 and no stack', async () => {
        const text = read('steady-5')
        for (const bad of [text.slice(0, text.length >> 1), text.slice(0, -2), '{"version":"1.0","events":[', '{"version":"1.0"}']) {
            const h = host({ 'b.sse-record': bad })
            expect(await main(['analyze', 'b.sse-record'], h.io), bad.slice(0, 30)).toBe(EXIT.usage)
            expect(h.err).not.toMatch(/could not finish|\bat\s+\S+\s+\(/)
        }
    })
})

describe('what importV1 does with a field that is not what a v1 export writes (hand-edited or damaged files)', () => {
    const one = (event: unknown) => importV1({ version: '1.0', events: [event] }).records[0] as unknown as Record<string, unknown>

    it('the SSE name is the recording\'s type; parsedType and the internal id are not it; a missing or empty type is "message"', () => {
        expect(one({ type: 'order', parsedType: 'other', id: 'uuid', data: 'x' })).toMatchObject({ event: 'order', sseId: '' })
        for (const type of [undefined, '', null]) expect(one({ type, data: 'x' }), String(type)).toMatchObject({ event: 'message' })
    })

    it('a gap is read as a number of milliseconds: strings of digits count, negative, missing, null and unreadable values are zero', () => {
        const times = (deltas: unknown[]) => importV1({ version: '1.0', events: deltas.map((deltaMs) => ({ data: '', deltaMs })) }).records.map((r) => r.t)
        expect(times([10, '5', undefined, null, -50, 'abc', {}, 20])).toEqual([10, 15, 15, 15, 15, 15, 15, 35])
    })

    it('data that is not a string is dropped to an empty payload, not turned into "[object Object]"', () => {
        for (const data of [undefined, null, 5, { a: 1 }, ['x']]) expect(one({ data }), JSON.stringify(data)).toMatchObject({ data: '', dataBytes: 0 })
    })

    it('a time can never go backwards, whatever the gaps say (the engine reads the capture as a clock)', () => {
        const records = importV1({ version: '1.0', events: [5, -1000, 0, -1, 7, -3].map((deltaMs) => ({ data: '', deltaMs })) }).records
        const times = records.map((r) => r.t)
        expect([...times].sort((a, b) => a - b)).toEqual(times)
    })

    it('versions: 1, 1.0, 1.5 and 1.0.3 are v1; 0.9, 2.0, 10.0 and the empty string are not', () => {
        for (const version of ['1', '1.0', '1.5', '1.0.3']) expect(importV1({ version, events: [] }).records).toEqual([])
        for (const version of ['0.9', '2.0', '10.0', '']) expect(() => importV1({ version, events: [] }), version).toThrow(V1ImportError)
        expect(() => importV1({ version: '2.0', events: [] })).toThrow(/unsupported \.sse-record version "2\.0"/)
    })

    it('what is not a recording is refused as one: other JSON, a version that is a number, events that are not a list', () => {
        for (const value of [null, 5, 'x', [], {}, { version: '1.0' }, { version: 1.0, events: [] }, { version: '1.0', events: {} }, { version: '1.0', events: 'abc' }]) {
            expect(() => importV1(value), JSON.stringify(value)).toThrow(V1ImportError)
            expect(isV1Recording(value)).toBe(false)
        }
    })

    it('an event that is not an object is refused with the recording error, not a TypeError (the CLI would otherwise exit 3, "could not run", instead of 2)', () => {
        for (const bad of [null, 5, 'text', true]) {
            expect(() => importV1({ version: '1.0', events: [{ data: 'a' }, bad] }), JSON.stringify(bad)).toThrow(V1ImportError)
        }
        expect(() => importV1({ version: '1.0', events: [{ data: 'a' }, null] })).toThrow(/events\[1\]/)
    })

    it('through the CLI a null event is an invalid recording (exit 2), and the Doctor says what is wrong with the file', async () => {
        const text = JSON.stringify({ version: '1.0', events: [{ data: 'a', deltaMs: 0 }, null] })
        const h = host({ 'n.sse-record': text })
        expect(await main(['analyze', 'n.sse-record'], h.io)).toBe(EXIT.usage)
        expect(h.err).toMatch(/events\[1\]/)
        const doctor = loadCaptureText(text)
        expect(doctor.ok).toBe(false)
        if (!doctor.ok) expect(doctor.error).toMatch(/events\[1\]/)
    })

    it('a recording with a gap too large for a number (1e999) still makes a capture that can be written and read', () => {
        const capture = importV1(JSON.parse('{"version":"1.0","events":[{"data":"a","deltaMs":1e999},{"data":"b","deltaMs":5}]}'))
        expect(capture.records.every((r) => Number.isFinite(r.t))).toBe(true)
        expect(parseCapture(serializeCapture(capture)).capture.records).toHaveLength(2)
    })

    it('odd names and ids never stop the analysis: numbers, objects, very long strings, control characters', () => {
        const events = [
            { type: 5, sseId: 7, data: 'a', deltaMs: 1 }, { type: { x: 1 }, sseId: ['y'], data: 'b', deltaMs: 1 }, { type: 'x'.repeat(100_000), sseId: 'i'.repeat(100_000), data: 'c', deltaMs: 1 },
            { type: 'a\u0000b\nc', sseId: '\u0000', data: 'd', deltaMs: 1 }, { type: '\ud800', sseId: '\udfff', data: 'e', deltaMs: 1 },
        ]
        const capture = importV1({ version: '1.0', events })
        expect(() => analyze(capture.records as Observation[])).not.toThrow()
        expect(() => parseCapture(serializeCapture(capture))).not.toThrow()
        const out = capture.records as unknown as Array<{ event: unknown; sseId: unknown }>
        expect(out.slice(2).every((r) => typeof r.event === 'string' && typeof r.sseId === 'string')).toBe(true)
        // OPEN QUESTION, pinned as it is today: a name or id that is a number or an object in the file is carried over as it is, not turned into text,
        // although the capture format says text. Nothing downstream throws on it; whether to coerce (and what an object should become) is a decision.
        expect([out[0]!.event, out[0]!.sseId]).toEqual([5, 7])
        expect([out[1]!.event, out[1]!.sseId]).toEqual([{ x: 1 }, ['y']])
    })

    it('20 000 events import in order, quickly, to a strictly ordered timeline', () => {
        const events = Array.from({ length: 20_000 }, (_, i) => ({ type: 'tick', sseId: String(i), data: JSON.stringify({ n: i }), deltaMs: i % 7 }))
        const start = Date.now()
        const capture = importV1({ version: '1.0', events })
        expect(Date.now() - start).toBeLessThan(2000)
        expect(capture.records).toHaveLength(20_000)
        expect(capture.records.map((r) => r.seq)).toEqual(events.map((_, i) => i))
        expect(analyze(capture.records as Observation[]).findings).toEqual([])
    })
})

describe('the mock server\'s own path for a v1 recording (no capture involved): what is kept and what is not', () => {
    const framesOfReplay = async (name: string): Promise<string[]> => {
        const { session, error } = validateSession(JSON.parse(read(name)))
        expect(error).toBeUndefined()
        const written: string[] = []
        const res = { write: (s: string) => { written.push(s); return true }, once: () => undefined, end: () => undefined }
        await replay({ res: res as never, session, speed: 1000, isClosed: () => false })
        return written
    }

    it('replays every event, in order, with its data, then says the recording is over', async () => {
        const raw = rawOf('named-unicode-multiline')
        const frames = await framesOfReplay('named-unicode-multiline')
        expect(frames).toHaveLength(raw.events.length + 1)
        expect(frames.at(-1)).toBe('event: end\ndata: {"done":true}\n\n')
        const dataOf = (frame: string) => frame.split('\n').filter((l) => l.startsWith('data: ')).map((l) => l.slice(6)).join('\n')
        expect(frames.slice(0, -1).map((f) => dataOf(f))).toEqual(['{"type":"order","sku":"café","total":5}', 'line one\nline two\n\nline four', '', '日本語 ✓ emoji 😀', '{"sku":"x","total":7,"type":"order"}'])
    })

    it('OPEN QUESTION, pinned as it is today: the id on a replayed frame is the recording\'s internal uuid, not the server\'s id (sseId), and the event name is not sent as "event:"', async () => {
        const raw = rawOf('named-unicode-multiline')
        const frames = await framesOfReplay('named-unicode-multiline')
        expect(frames[0]!.startsWith(`id: ${raw.events[0]!.id}\n`)).toBe(true)
        expect(frames[0]).not.toContain('id: 10')
        for (const f of frames) expect(f).not.toMatch(/^event: (order|heartbeat)/m)
    })
})
