import { describe, it, expect } from 'vitest'
import { CaptureStore } from '../captureStore'
import type { Observation, ObservationBody } from '../observation'

let seq = 0
const rec = (body: ObservationBody, t = seq): Observation => ({ seq: seq++, t, conn: 0, ...body }) as Observation
const chunk = (t?: number) => rec({ kind: 'chunk', bytes: 100 }, t)
const event = (id: string, t?: number) => rec({ kind: 'event', event: 'message', sseId: id, dataBytes: 20, dataHash: 'abc' }, t)
const comment = (text: string, t: number) => rec({ kind: 'comment', text, source: 'upstream' }, t)
const kinds = (store: CaptureStore) => store.snapshot().map((o) => o.kind)

describe('CaptureStore', () => {
    it('keeps records in order and counts everything it has seen', () => {
        seq = 0
        const store = new CaptureStore()
        store.append(rec({ kind: 'connect', attempt: 0, url: '/s', method: 'GET', headerNames: [], sentLastEventId: '' }))
        store.append(chunk())
        store.append(event('1'))
        expect(store.snapshot().map((o) => o.seq)).toEqual([0, 1, 2])
        expect(store.stats).toMatchObject({ total: 3, byKind: { connect: 1, chunk: 1, event: 1 }, chunkBytesTotal: 100, dropped: { chunk: 0, event: 0, heartbeat: 0, violation: 0 } })
    })

    it('stays within its cap by dropping chunk detail first, then event detail, and says exactly what it dropped', () => {
        seq = 0
        const store = new CaptureStore({ capBytes: 20_000 })
        store.append(rec({ kind: 'response', status: 200, contentType: 'text/event-stream', redirected: false, headers: {}, ttfbMs: 5 }))
        for (let i = 0; i < 3000; i++) { store.append(chunk()); store.append(event(String(i))) }

        const stats = store.stats
        expect(stats.total).toBe(1 + 6000)
        expect(stats.retainedBytes).toBeLessThanOrEqual(20_000)
        // chunks go first: every chunk is dropped before any event is
        expect(stats.dropped.chunk).toBe(3000)
        expect(stats.dropped.event).toBeGreaterThan(0)
        expect(stats.chunkBytesTotal).toBe(300_000) // totals survive eviction

        const snapshot = store.snapshot()
        expect(snapshot.filter((o) => o.kind === 'chunk')).toHaveLength(0)
        expect(snapshot.filter((o) => o.kind === 'response')).toHaveLength(1) // never evicted
        const retainedEvents = snapshot.filter((o) => o.kind === 'event').length
        expect(retainedEvents + stats.dropped.event).toBe(3000) // nothing vanishes unaccounted for
        // explicit markers, one per kind of detail, carrying the running drop count
        const markers = snapshot.filter((o): o is Extract<Observation, { kind: 'truncated' }> => o.kind === 'truncated')
        expect(markers.map((m) => [m.what, m.dropped]).sort()).toEqual([['chunk', 3000], ['event', stats.dropped.event]].sort())
        // the newest events are the ones kept
        expect(snapshot.filter((o) => o.kind === 'event').at(-1)).toMatchObject({ sseId: '2999' })
    })

    it('places the truncation marker where the first drop happened, so order is preserved', () => {
        seq = 0
        const store = new CaptureStore({ capBytes: 500 })
        for (let i = 0; i < 20; i++) store.append(chunk())
        const snapshot = store.snapshot()
        const seqs = snapshot.map((o) => o.seq)
        expect(seqs).toEqual([...seqs].sort((a, b) => a - b))
        expect(snapshot[0]).toMatchObject({ kind: 'truncated', what: 'chunk', seq: 0 })
    })

    it('never evicts connections, responses, phases, reconnects or marks', () => {
        seq = 0
        const store = new CaptureStore({ capBytes: 2000 })
        store.append(rec({ kind: 'connect', attempt: 0, url: '/s', method: 'GET', headerNames: [], sentLastEventId: '' }))
        store.append(rec({ kind: 'phase', phase: 'open', info: { attempt: 0 } }))
        store.append(rec({ kind: 'reconnect', attempt: 1, delayMs: 1000, reason: 'closed', lastEventIdSent: '5' }))
        for (let i = 0; i < 2000; i++) { store.append(chunk()); store.append(event(String(i))) }
        expect(kinds(store)).toEqual(expect.arrayContaining(['connect', 'phase', 'reconnect']))
    })

    describe('heartbeats', () => {
        it('folds a flood of identical heartbeats into one series with correct gap statistics, and keeps the cap', () => {
            seq = 0
            const store = new CaptureStore({ capBytes: 6000 })
            for (let i = 0; i < 20_000; i++) store.append(comment(`ping ${i}`, i * 1000)) // every second; the text differs only in digits
            const stats = store.stats
            expect(stats.retainedBytes).toBeLessThanOrEqual(6000)
            const snapshot = store.snapshot()
            const series = snapshot.filter((o): o is Extract<Observation, { kind: 'heartbeatSeries' }> => o.kind === 'heartbeatSeries')
            expect(series).toHaveLength(1)
            expect(series[0]).toMatchObject({ text: 'ping #', source: 'upstream', minGapMs: 1000, maxGapMs: 1000, meanGapMs: 1000, firstT: 0 })
            const retainedComments = snapshot.filter((o) => o.kind === 'comment').length
            expect(retainedComments + series[0]!.count).toBe(20_000) // every heartbeat is either kept or counted in the series
            expect(stats.dropped.heartbeat).toBe(series[0]!.count - 1)
            expect(snapshot.some((o) => o.kind === 'truncated' && o.what === 'heartbeat')).toBe(true)
        })

        it('still bounds memory when every heartbeat is different, by folding into one catch-all series per source', () => {
            seq = 0
            const store = new CaptureStore({ capBytes: 8000 })
            for (let i = 0; i < 5000; i++) store.append(comment(`unique-${'abcdefghij'[i % 10]}${'klmnopqrst'[(i >> 3) % 10]}-text`, i))
            expect(store.stats.retainedBytes).toBeLessThanOrEqual(8000)
            expect(store.snapshot().some((o) => o.kind === 'heartbeatSeries' && o.text === '(various)')).toBe(true)
        })

        it('keeps heartbeats as individual records while there is room', () => {
            seq = 0
            const store = new CaptureStore()
            for (let i = 0; i < 100; i++) store.append(comment('hb', i))
            expect(kinds(store).filter((k) => k === 'comment')).toHaveLength(100)
            expect(store.stats.dropped.heartbeat).toBe(0)
        })
    })

    it('keeps only the first and latest violations per code once a code floods, and counts the rest', () => {
        seq = 0
        const store = new CaptureStore()
        for (let i = 0; i < 1000; i++) store.append(rec({ kind: 'violation', code: 'UNKNOWN_FIELD', severity: 'info', detail: `field ${i}` }))
        store.append(rec({ kind: 'violation', code: 'NUL_IN_ID', severity: 'warning', detail: 'once' }))
        const violations = store.snapshot().filter((o) => o.kind === 'violation')
        expect(violations.filter((o) => o.kind === 'violation' && o.code === 'UNKNOWN_FIELD')).toHaveLength(100)
        expect(violations.filter((o) => o.kind === 'violation' && o.code === 'NUL_IN_ID')).toHaveLength(1) // a rare code is never crowded out
        expect(store.stats.dropped.violation).toBe(900)
        expect(store.stats.byKind.violation).toBe(1001)
        expect(store.snapshot().some((o) => o.kind === 'truncated' && o.what === 'violation')).toBe(true)
    })

    it('holds memory under the cap through a long mixed stream (500k records)', () => {
        seq = 0
        const store = new CaptureStore({ capBytes: 1024 * 1024 })
        let peak = 0
        for (let i = 0; i < 500_000; i++) {
            const m = i % 50
            if (m === 0) store.append(comment('keep-alive', i))
            else if (m % 2 === 0) store.append(chunk(i))
            else store.append(event(String(i), i))
            if (i % 1000 === 0) peak = Math.max(peak, store.stats.retainedBytes)
        }
        expect(Math.max(peak, store.stats.retainedBytes)).toBeLessThanOrEqual(1024 * 1024)
        expect(store.stats.total).toBe(500_000)
    })

    it('clear() forgets everything, including totals and markers', () => {
        seq = 0
        const store = new CaptureStore({ capBytes: 300 })
        for (let i = 0; i < 50; i++) store.append(chunk())
        store.clear()
        expect(store.snapshot()).toEqual([])
        expect(store.stats).toMatchObject({ total: 0, retainedBytes: 0, chunkBytesTotal: 0, dropped: { chunk: 0, event: 0, heartbeat: 0, violation: 0 } })
        store.append(chunk())
        expect(store.snapshot()).toHaveLength(1) // and a fresh marker is not shadowed by the old one
    })
})
