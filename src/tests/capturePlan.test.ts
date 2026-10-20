// @vitest-environment node
import { describe, it, expect } from 'vitest'
import { planReplay, sessionFromCapture, looksLikeCapture } from '../../lib/mock/capturePlan.js'
import { validateSession } from '../../lib/mock/session.js'
import { bytesToBase64 } from '../core/capture/base64'
import { importV1 } from '../core/capture/importV1'
import { newHeader, serializeCapture, type Capture } from '../core/capture/format'

const enc = (s: string) => new TextEncoder().encode(s)
const chunk = (seq: number, conn: number, t: number, text: string) => ({ seq, t, conn, kind: 'chunk' as const, bytes: enc(text).length, b64: bytesToBase64(enc(text)) })

const withBytes = (records: Capture['records']): Capture => ({ header: newHeader({ kind: 'local-full', source: { kind: 'fixture' } }), records })
const session = (capture: Capture) => {
    const { session: s, error } = sessionFromCapture(serializeCapture(capture)) as { session?: ReturnType<typeof Object>; error?: string }
    if (!s) throw new Error(error)
    return s as never
}
const writes = (steps: Array<{ write: string | Buffer }>) => steps.map((s) => s.write.toString())

describe('reading a capture upload', () => {
    it('takes NDJSON text, a Buffer, a JSON envelope with the text, and a parsed capture object', () => {
        const capture = withBytes([chunk(0, 0, 0, 'id: 1\ndata: a\n\n')])
        const text = serializeCapture(capture)
        for (const body of [text, Buffer.from(text), { capture: text }, { capture: { header: capture.header, records: capture.records } }]) {
            expect(looksLikeCapture(body)).toBe(true)
            expect(sessionFromCapture(body).session?.chunks).toHaveLength(1)
        }
        expect(looksLikeCapture({ events: [] })).toBe(false)
    })

    it('keeps old v1 uploads exactly as they were', () => {
        const { session: s, error } = validateSession({ version: '1.0', events: [{ id: 1, type: 'a', data: 'x', deltaMs: 5 }] })
        expect(error).toBeUndefined()
        expect(s).toEqual({ events: [{ id: '1', type: 'a', data: 'x', deltaMs: 5 }] })
    })

    it('says what is wrong with a file that cannot be replayed', () => {
        expect(sessionFromCapture('not json').error).toMatch(/not JSON|not an sse-capture/)
        expect(sessionFromCapture({ capture: { header: { format: 'sse-capture', version: '3.0' }, records: [] } }).error).toMatch(/Unsupported capture version/)
        const noPayload = withBytes([{ seq: 0, t: 0, conn: 0, kind: 'chunk', bytes: 10 }])
        expect(sessionFromCapture(serializeCapture(noPayload)).error).toMatch(/no payload to replay/)
    })

    it('ignores a cut-off last line like the real reader', () => {
        const text = serializeCapture(withBytes([chunk(0, 0, 0, 'data: a\n\n'), chunk(1, 0, 5, 'data: b\n\n')]))
        const cut = text.trimEnd().split('\n').slice(0, 3).join('\n') + '\n{"seq":2,"t":9,"co'
        expect(sessionFromCapture(cut).session?.chunks).toHaveLength(2)
    })
})

describe('planReplay: chunk-faithful', () => {
    const s = session(withBytes([chunk(0, 0, 100, ': hello\n\n'), chunk(1, 0, 130, 'id: 1\ndata: a\n\nid: 2\nda'), chunk(2, 0, 4130, 'ta: b\n\n')]))

    it('writes each read again at its recorded time, with its original boundaries (a frame split across reads stays split)', () => {
        const plan = planReplay(s)
        expect(plan.mode).toBe('chunk-faithful')
        expect(plan.steps.map((x) => x.atMs)).toEqual([0, 30, 4030])
        expect(writes(plan.steps)).toEqual([': hello\n\n', 'id: 1\ndata: a\n\nid: 2\nda', 'ta: b\n\n'])
        expect(Buffer.isBuffer(plan.steps[0]!.write)).toBe(true)
    })

    it('scales time with the speed, and can drop the connection after N reads', () => {
        expect(planReplay(s, { speed: 10 }).steps.map((x) => x.atMs)).toEqual([0, 3, 403])
        expect(planReplay(s, { dropAfter: 2 }).steps).toHaveLength(2)
    })

    it('replays the redacted text of a sanitized capture', () => {
        const sanitized: Capture = { header: newHeader({ kind: 'sanitized', source: { kind: 'fixture' } }), records: [{ seq: 0, t: 0, conn: 0, kind: 'chunk', bytes: 99, text: 'data: [REDACTED_1]\n\n' }] }
        const plan = planReplay(session(sanitized))
        expect(writes(plan.steps)).toEqual(['data: [REDACTED_1]\n\n'])
    })

    it('serves the recorded connection for a request, and the last one when there are fewer', () => {
        const two = session(withBytes([chunk(0, 0, 0, 'data: first\n\n'), chunk(1, 1, 500, 'data: second\n\n')]))
        expect(writes(planReplay(two, { connection: 0 }).steps)).toEqual(['data: first\n\n'])
        expect(writes(planReplay(two, { connection: 1 }).steps)).toEqual(['data: second\n\n'])
        expect(writes(planReplay(two, { connection: 7 }).steps)).toEqual(['data: second\n\n'])
    })
})

describe('planReplay: event-level (resume, skipping ids)', () => {
    const log = session(withBytes([
        chunk(0, 0, 0, ': hb\n\nid: 1\ndata: a\n\nid: 2\ndata: b\n\n'),
        chunk(1, 0, 1000, 'id: 3\ndata: c\n\n'),
        chunk(2, 1, 5000, 'id: 3\ndata: c\n\nid: 4\ndata: d\n\n'), // the resumed connection replays 3, then continues
    ]))

    it('resumes after the id the client sent, keeping each id once across connections', () => {
        const plan = planReplay(log, { honorLastEventId: true, lastEventId: '2' })
        expect(plan.mode).toBe('event-level')
        expect(writes(plan.steps)).toEqual(['id: 3\ndata: c\n\n', 'id: 4\ndata: d\n\n'])
    })

    it('handles an id that is not in the capture as asked', () => {
        const base = { honorLastEventId: true, lastEventId: 'nope' }
        expect(planReplay(log, base).steps).toHaveLength(5) // from the start, the heartbeat comment included
        expect(planReplay(log, { ...base, unknownId: 'ignore' }).steps).toEqual([])
        expect(planReplay(log, { ...base, unknownId: '400' }).error).toMatchObject({ status: 400 })
    })

    it('leaves out the ids it is told to skip and keeps comments', () => {
        const plan = planReplay(log, { skipIds: ['2'] })
        expect(writes(plan.steps)).toEqual([': hb\n\n', 'id: 1\ndata: a\n\n', 'id: 3\ndata: c\n\n'])
    })

    it('rebuilds frames from the events of an imported v1 recording, with their ids, names and timing', () => {
        const v1 = importV1({ version: '1.0', events: [{ type: 'order', data: '{"n":1}', sseId: '10', deltaMs: 0 }, { type: 'message', data: 'two\nlines', sseId: '', deltaMs: 200 }] })
        const plan = planReplay(session(v1))
        expect(writes(plan.steps)).toEqual(['id: 10\nevent: order\ndata: {"n":1}\n\n', 'data: two\ndata: lines\n\n'])
        expect(plan.steps.map((x) => x.atMs)).toEqual([0, 200])
    })
})
