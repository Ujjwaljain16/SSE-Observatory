import { describe, it, expect, beforeEach } from 'vitest'
import 'fake-indexeddb/auto'
import { indexedDB } from 'fake-indexeddb'
import type { EventMessage } from '../../types'

    // Polyfill so our module uses fake-indexeddb
    ; (globalThis as any).indexedDB = indexedDB

import {
    openDB,
    putBatch,
    getAllAfter,
    countAll,
    clearStore,
    deleteOldest,
    resetDBInstance,
} from '../../utils/idbUtils'

const makeEvent = (id: string, arrivalTime: number, data = '{}'): EventMessage => ({
    id,
    timestamp: '',
    type: 'message',
    data,
    raw: '',
    arrivalTime,
})

describe('idbUtils', () => {
    let db: IDBDatabase

    beforeEach(async () => {
        // Fresh DB for each test
        resetDBInstance()
        db = await openDB()
        await clearStore(db)
    })

    // --------------------------------------------------
    it('opens the database successfully', async () => {
        expect(db).toBeDefined()
        expect(db.name).toBe('sse-tester-db')
    })

    // --------------------------------------------------
    it('putBatch stores multiple events in a single transaction', async () => {
        const batch = [
            makeEvent('e1', 100),
            makeEvent('e2', 200),
            makeEvent('e3', 300),
        ]
        await putBatch(db, batch)
        const count = await countAll(db)
        expect(count).toBe(3)
    })

    // --------------------------------------------------
    it('putBatch is a no-op for empty arrays', async () => {
        await putBatch(db, [])
        const count = await countAll(db)
        expect(count).toBe(0)
    })

    // --------------------------------------------------
    it('getAllAfter returns all events when no cursor given', async () => {
        await putBatch(db, [makeEvent('a', 100), makeEvent('b', 200), makeEvent('c', 300)])
        const results = await getAllAfter(db, null)
        expect(results).toHaveLength(3)
    })

    // --------------------------------------------------
    it('getAllAfter paginates correctly using cursor', async () => {
        await putBatch(db, [
            makeEvent('a', 100),
            makeEvent('b', 200),
            makeEvent('c', 300),
            makeEvent('d', 400),
        ])
        // Load first 2
        const page1 = await getAllAfter(db, null, 2)
        expect(page1).toHaveLength(2)
        expect(page1[0].id).toBe('a')
        expect(page1[1].id).toBe('b')

        // Load next 2, starting after last arrivalTime of page1
        const page2 = await getAllAfter(db, page1[page1.length - 1].arrivalTime!, 2)
        expect(page2).toHaveLength(2)
        expect(page2[0].id).toBe('c')
    })

    // --------------------------------------------------
    it('getAllAfter returns events sorted by arrivalTime ascending', async () => {
        await putBatch(db, [
            makeEvent('z', 900),
            makeEvent('a', 100),
            makeEvent('m', 500),
        ])
        const results = await getAllAfter(db, null)
        const times = results.map(e => e.arrivalTime!)
        expect(times).toEqual([100, 500, 900])
    })

    // --------------------------------------------------
    it('countAll returns correct count', async () => {
        await putBatch(db, [makeEvent('x', 1), makeEvent('y', 2)])
        expect(await countAll(db)).toBe(2)
    })

    // --------------------------------------------------
    it('clearStore wipes all events', async () => {
        await putBatch(db, [makeEvent('x', 1), makeEvent('y', 2)])
        await clearStore(db)
        expect(await countAll(db)).toBe(0)
    })

    // --------------------------------------------------
    it('deleteOldest removes the N oldest events by arrivalTime', async () => {
        await putBatch(db, [
            makeEvent('old1', 100),
            makeEvent('old2', 200),
            makeEvent('keep1', 300),
            makeEvent('keep2', 400),
        ])
        await deleteOldest(db, 2)
        const remaining = await getAllAfter(db, null)
        expect(remaining).toHaveLength(2)
        expect(remaining.map(e => e.id)).toContain('keep1')
        expect(remaining.map(e => e.id)).toContain('keep2')
        expect(remaining.map(e => e.id)).not.toContain('old1')
    })

    // --------------------------------------------------
    it('IDB FALLBACK: gracefully rejects when indexedDB throws', async () => {
        // Simulate IDB being unavailable
        const original = (globalThis as any).indexedDB
            ; (globalThis as any).indexedDB = undefined
        resetDBInstance()

        try {
            await openDB()
            // If we get here, fail the test
            expect(true).toBe(false) // Should not reach
        } catch (e: any) {
            expect(e.message).toContain('IDB not available')
        } finally {
            ; (globalThis as any).indexedDB = original
            resetDBInstance()
        }
    })
})
