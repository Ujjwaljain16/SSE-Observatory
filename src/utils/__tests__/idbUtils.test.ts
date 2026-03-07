import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { openDB, putBatch, getAllAfter, countAll, clearStore, deleteOldest, resetDBInstance } from '../idbUtils'
import type { EventMessage } from '../../types'

describe('idbUtils', () => {
    let db: IDBDatabase

    beforeEach(async () => {
        resetDBInstance()
        db = await openDB()
        await clearStore(db)
    })

    afterEach(async () => {
        try {
            await clearStore(db)
        } catch { }
        if (db) db.close()
    })

    const createEvents = (count: number): EventMessage[] => {
        return Array.from({ length: count }, (_, i) => ({
            id: `evt-${i}`,
            data: JSON.stringify({ test: true }),
            arrivalTime: Date.now() + i,
            timestamp: new Date().toISOString(),
            type: 'message',
            raw: '...',
        }))
    }

    it('should open database and create store', async () => {
        expect(db).toBeDefined()
        expect(db.objectStoreNames.contains('events')).toBe(true)
    })

    it('should put and get a batch of events', async () => {
        const events = createEvents(5)
        await putBatch(db, events)

        const count = await countAll(db)
        expect(count).toBe(5)

        const stored = await getAllAfter(db, null, 10)
        expect(stored.length).toBe(5)
        expect(stored[0].id).toBe('evt-0')
        expect(stored[4].id).toBe('evt-4')
    })

    it('should paginate using getAllAfter', async () => {
        const events = createEvents(10)
        await putBatch(db, events)

        // Get first 5
        const firstPage = await getAllAfter(db, null, 5)
        expect(firstPage.length).toBe(5)
        expect(firstPage[4].id).toBe('evt-4')

        // Get next 5 using the arrivalTime of the last item
        const lastTime = firstPage[4].arrivalTime!
        const secondPage = await getAllAfter(db, lastTime, 5)
        expect(secondPage.length).toBe(5)
        // Note: lowerBound(val, true) means > val
        expect(secondPage[0].id).toBe('evt-5')
    })

    it('should clear store', async () => {
        await putBatch(db, createEvents(3))
        expect(await countAll(db)).toBe(3)
        await clearStore(db)
        expect(await countAll(db)).toBe(0)
    })

    it('should evict oldest events', async () => {
        await putBatch(db, createEvents(10))
        await deleteOldest(db, 4)
        const remaining = await countAll(db)
        expect(remaining).toBe(6)

        const all = await getAllAfter(db, null, 10)
        expect(all[0].id).toBe('evt-4') // 0, 1, 2, 3 should be gone
    })

    describe('IDB Corruption & Storage Limits (Edge Cases)', () => {

        it('should handle QuotaExceededError gracefully by throwing', async () => {
            // Mock transaction to throw QuotaExceededError
            const originalTx = db.transaction.bind(db)
            vi.spyOn(db, 'transaction').mockImplementationOnce((storeNames, mode) => {
                const tx = originalTx(storeNames, mode)
                // Override objectStore to inject the error on put
                const originalObjectStore = tx.objectStore.bind(tx)
                vi.spyOn(tx, 'objectStore').mockImplementationOnce((name) => {
                    const store = originalObjectStore(name)
                    vi.spyOn(store, 'put').mockImplementationOnce(() => {
                        throw new DOMException('Quota Exceeded', 'QuotaExceededError')
                    })
                    return store
                })
                return tx
            })

            await expect(putBatch(db, createEvents(1))).rejects.toThrow('Quota Exceeded')
        })

        it('should handle TransactionInactiveError and not freeze', async () => {
            const originalTx = db.transaction.bind(db)
            vi.spyOn(db, 'transaction').mockImplementationOnce((storeNames, mode) => {
                const tx = originalTx(storeNames, mode)
                const originalObjectStore = tx.objectStore.bind(tx)
                vi.spyOn(tx, 'objectStore').mockImplementationOnce((name) => {
                    const store = originalObjectStore(name)
                    vi.spyOn(store, 'put').mockImplementationOnce(() => {
                        throw new DOMException('Transaction has been aborted', 'TransactionInactiveError')
                    })
                    return store
                })
                return tx
            })

            await expect(putBatch(db, createEvents(1))).rejects.toThrow('Transaction has been aborted')
        })

        it('should handle database deletion mid-stream', async () => {
            // Force close then delete db
            db.close()
            resetDBInstance()

            await new Promise<void>((resolve, reject) => {
                const req = indexedDB.deleteDatabase('sse-tester-db')
                req.onsuccess = () => resolve()
                req.onerror = () => reject(req.error)
            })

            // It should successfully reopen
            const newDb = await openDB()
            expect(newDb).toBeDefined()
            await putBatch(newDb, createEvents(1))
            expect(await countAll(newDb)).toBe(1)
            newDb.close()
        })
    })
})
