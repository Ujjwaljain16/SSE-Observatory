import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { openDB, putBatch, getPage, readAllNewestFirst, deleteOldest, countAll, clearStore, resetDBInstance, DB_NAME, cursorOf } from '../idbUtils'
import type { EventMessage } from '../../types'

const T = 1_700_000_000_000
const mk = (i: number, arrivalTime: number, seq = i): EventMessage =>
    ({ id: `id-${i}`, type: 'message', timestamp: '', data: '{}', raw: '', arrivalTime, seq })

async function fresh() {
    resetDBInstance()
    await new Promise<void>((resolve) => {
        const req = indexedDB.deleteDatabase(DB_NAME)
        req.onsuccess = () => resolve()
        req.onerror = () => resolve()
        req.onblocked = () => resolve()
    })
    return openDB()
}

describe('IndexedDB ordering and paging', () => {
    let db: IDBDatabase
    beforeEach(async () => { db = await fresh() })
    afterEach(() => { db.close(); resetDBInstance() })

    it('pages through events that share a millisecond without skipping or repeating any', async () => {
        // 1200 events in only 3 distinct milliseconds (400 per ms), inserted in shuffled order
        const events = Array.from({ length: 1200 }, (_, i) => mk(i, T + Math.floor(i / 400)))
        await putBatch(db, [...events].sort(() => Math.random() - 0.5))

        const seen: string[] = []
        let cursor = null as ReturnType<typeof cursorOf>
        for (;;) {
            const page = await getPage(db, cursor, 500)
            if (page.length === 0) break
            seen.push(...page.map((e) => e.id))
            cursor = cursorOf(page[page.length - 1])
        }
        expect(seen).toHaveLength(1200)
        expect(new Set(seen).size).toBe(1200)
        expect(seen).toEqual(events.map((e) => e.id)) // total order: (arrivalTime, seq)
    })

    it('readAllNewestFirst returns everything, newest first', async () => {
        const events = Array.from({ length: 1300 }, (_, i) => mk(i, T + Math.floor(i / 650)))
        await putBatch(db, events)
        const all = await readAllNewestFirst(db)
        expect(all).toHaveLength(1300)
        expect(all[0].id).toBe('id-1299')
        expect(all[1299].id).toBe('id-0')
        expect(await readAllNewestFirst(db, 100)).toHaveLength(100) // honours the cap
    })

    it('"prev" pages walk backwards from a cursor', async () => {
        await putBatch(db, Array.from({ length: 10 }, (_, i) => mk(i, T + i)))
        const older = await getPage(db, { arrivalTime: T + 7, seq: 7 }, 3, 'prev')
        expect(older.map((e) => e.id)).toEqual(['id-6', 'id-5', 'id-4'])
    })

    it('deleteOldest removes the oldest by arrival order, including ties', async () => {
        await putBatch(db, [mk(0, T), mk(1, T), mk(2, T), mk(3, T + 1), mk(4, T + 1)])
        await deleteOldest(db, 2)
        const rest = await readAllNewestFirst(db)
        expect(rest.map((e) => e.id)).toEqual(['id-4', 'id-3', 'id-2'])
        expect(await countAll(db)).toBe(3)
    })

    it('opening the database concurrently shares one connection', async () => {
        resetDBInstance()
        const [a, b, c] = await Promise.all([openDB(), openDB(), openDB()])
        expect(a).toBe(b)
        expect(b).toBe(c)
        db = a
    })

    it('rejects when a write transaction fails instead of hanging', async () => {
        await putBatch(db, [mk(1, T)])
        // a store transaction on a closed connection must reject, not stay pending forever
        const closed = await openDB()
        closed.close()
        resetDBInstance()
        await expect(clearStore(closed)).rejects.toBeTruthy()
        db = await openDB()
    })
})

describe('upgrade from schema v1', () => {
    afterEach(() => resetDBInstance())

    it('adds seq to existing records in arrival order and indexes them', async () => {
        resetDBInstance()
        await new Promise<void>((r) => { const q = indexedDB.deleteDatabase(DB_NAME); q.onsuccess = q.onerror = q.onblocked = () => r() })

        // Build a v1 database exactly as the old code did
        await new Promise<void>((resolve, reject) => {
            const req = indexedDB.open(DB_NAME, 1)
            req.onupgradeneeded = () => {
                const store = req.result.createObjectStore('events', { keyPath: 'id' })
                store.createIndex('arrivalTime', 'arrivalTime', { unique: false })
            }
            req.onsuccess = () => {
                const db1 = req.result
                const tx = db1.transaction('events', 'readwrite')
                const store = tx.objectStore('events')
                store.put({ id: 'old-b', type: 'message', timestamp: '', data: '{}', raw: '', arrivalTime: T + 5 })
                store.put({ id: 'old-a', type: 'message', timestamp: '', data: '{}', raw: '', arrivalTime: T })
                tx.oncomplete = () => { db1.close(); resolve() }
                tx.onerror = () => reject(tx.error)
            }
            req.onerror = () => reject(req.error)
        })

        const db2 = await openDB() // triggers the v1 → v2 upgrade
        const all = await getPage(db2, null, 10)
        expect(all.map((e) => e.id)).toEqual(['old-a', 'old-b'])
        expect(all.every((e) => typeof e.seq === 'number')).toBe(true)
        expect((await readAllNewestFirst(db2)).map((e) => e.id)).toEqual(['old-b', 'old-a'])
        db2.close()
    })
})
