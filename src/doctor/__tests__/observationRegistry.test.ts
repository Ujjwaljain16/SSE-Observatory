import { describe, it, expect, vi } from 'vitest'
import { ObservationRegistry } from '../observationRegistry'
import { CaptureStore } from '../../core/observe/captureStore'
import type { Observation } from '../../core/observe/observation'

let seq = 0
const chunk = (bytes = 10): Observation => ({ seq: seq++, t: seq, conn: 0, kind: 'chunk', bytes })
const sizes = (r: ObservationRegistry, id: string) => r.get(id)!.store.snapshot().map((o) => (o.kind === 'chunk' ? o.bytes : -1))

describe('ObservationRegistry: records from the worker', () => {
    it('collects batches per stream, in order, under the capture id', () => {
        const r = new ObservationRegistry()
        r.receive('main', { captureId: 'c1', batch: [chunk(1), chunk(2)] })
        r.receive('main', { captureId: 'c1', batch: [chunk(3)] })
        r.receive('lane-a', { captureId: 'x', batch: [chunk(9)] })
        expect(sizes(r, 'main')).toEqual([1, 2, 3])
        expect(sizes(r, 'lane-a')).toEqual([9])
        expect(r.get('main')!.captureId).toBe('c1')
        expect(r.ids().sort()).toEqual(['lane-a', 'main'])
    })

    it('a new capture id means the connection restarted: old records are dropped', () => {
        const r = new ObservationRegistry()
        r.receive('main', { captureId: 'c1', batch: [chunk(1), chunk(2)] })
        r.receive('main', { captureId: 'c2', batch: [chunk(7)] })
        expect(sizes(r, 'main')).toEqual([7])
    })

    it('a replace batch (sent to a late joiner) overwrites instead of duplicating what is held', () => {
        const r = new ObservationRegistry()
        const history = [chunk(1), chunk(2), chunk(3)]
        r.receive('main', { captureId: 'c1', batch: history })
        r.receive('main', { captureId: 'c1', batch: history, replace: true })
        expect(sizes(r, 'main')).toEqual([1, 2, 3])
    })

    it('is bounded like any store: a long stream cannot grow it without limit', () => {
        const r = new ObservationRegistry()
        for (let i = 0; i < 400; i++) r.receive('main', { captureId: 'c', batch: Array.from({ length: 500 }, () => chunk()) })
        expect(r.get('main')!.store.stats.retainedBytes).toBeLessThanOrEqual(8 * 1024 * 1024)
        expect(r.get('main')!.store.stats.total).toBe(200_000)
    })
})

describe('ObservationRegistry: streams running in this page', () => {
    it('adopts the stream\'s own store without copying it, and sees later appends', () => {
        const r = new ObservationRegistry()
        const store = new CaptureStore()
        r.attach('main', store, 'cap-1')
        store.append(chunk(5))
        expect(sizes(r, 'main')).toEqual([5])
        expect(r.get('main')!.store).toBe(store)
    })

    it('attaching again (the stream restarted) replaces the old store and clears the consumer samples', () => {
        const r = new ObservationRegistry()
        r.attach('main', new CaptureStore(), 'cap-1')
        r.recordConsumer('main', { kind: 'consumer', n: 1, queueDepth: 0, receivedT: 1, processedT: 2, lagMs: 1 })
        const fresh = new CaptureStore()
        r.attach('main', fresh, 'cap-2')
        expect(r.get('main')!.store).toBe(fresh)
        expect(r.get('main')!.captureId).toBe('cap-2')
        expect(r.get('main')!.consumer).toEqual([])
    })
})

describe('ObservationRegistry: consumer samples, notifications, lifecycle', () => {
    it('keeps page-domain consumer samples separately, stamped by their own recorder, and bounded', () => {
        const r = new ObservationRegistry()
        r.attach('main', new CaptureStore(), 'c')
        for (let i = 0; i < 2500; i++) r.recordConsumer('main', { kind: 'consumer', n: 1, queueDepth: i, receivedT: i, processedT: i + 5, lagMs: 5 })
        const samples = r.get('main')!.consumer
        expect(samples).toHaveLength(2000)
        expect(samples.at(-1)).toMatchObject({ kind: 'consumer', queueDepth: 2499, domain: 'page', seq: 2499 })
        expect(r.get('main')!.store.snapshot()).toEqual([]) // not mixed into the transport records
        r.recordConsumer('unknown', { kind: 'consumer', n: 1, queueDepth: 0, receivedT: 0, processedT: 0, lagMs: 0 }) // no entry: ignored
    })

    it('tells subscribers when anything changes, and stops after unsubscribe', () => {
        const r = new ObservationRegistry()
        const listener = vi.fn()
        const stop = r.subscribe(listener)
        r.receive('main', { captureId: 'c', batch: [chunk()] })
        r.notify('main')
        r.close('main')
        expect(listener).toHaveBeenCalledTimes(3)
        stop()
        r.receive('main', { captureId: 'c', batch: [chunk()] })
        expect(listener).toHaveBeenCalledTimes(3)
    })

    it('gives each change a new version, and reset/close forget the stream', () => {
        const r = new ObservationRegistry()
        r.receive('main', { captureId: 'c', batch: [chunk()] })
        const v1 = r.get('main')!.version
        r.receive('main', { captureId: 'c', batch: [chunk()] })
        expect(r.get('main')!.version).toBeGreaterThan(v1)
        r.reset('main')
        expect(r.get('main')).toBeUndefined()
        r.receive('lane', { captureId: 'c', batch: [chunk()] })
        r.close('lane')
        expect(r.get('lane')).toBeUndefined()
        expect(() => { r.reset('nope'); r.close('nope'); r.notify('nope') }).not.toThrow()
    })
})
