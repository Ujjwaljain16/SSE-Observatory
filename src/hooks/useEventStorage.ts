import { useState, useEffect, useRef, useCallback } from 'react'
import type { EventMessage } from '../types'
import { openDB, putBatch, countAll, clearStore, deleteOldest, readAllNewestFirst } from '../utils/idbUtils'

const FLUSH_INTERVAL_MS = 100
const FLUSH_BATCH_SIZE = 50
/** Events per IndexedDB transaction. Larger transactions are far cheaper than many small ones. */
const WRITE_BATCH = 200
/** Cold storage is best effort: if writes cannot keep up, the oldest pending ones are dropped instead of growing memory. */
export const MAX_PENDING_WRITES = 20_000
export const MAX_STORED_EVENTS = 100_000

interface UseEventStorageReturn {
    idbAvailable: boolean
    totalStoredCount: number
    saveEvent: (event: EventMessage) => void
    /** Stored events, newest first: all of them (up to MAX_STORED_EVENTS) or only the newest `limit`. Resolves to [] when storage is unavailable. */
    loadHistory: (limit?: number) => Promise<EventMessage[]>
    clearStorage: () => Promise<void>
}

/**
 * Cold storage: events are written to IndexedDB in small batches and the oldest are evicted beyond
 * MAX_STORED_EVENTS. Everything degrades to "RAM only" if IndexedDB is unavailable or full.
 */
export const useEventStorage = (): UseEventStorageReturn => {
    const [idbAvailable, setIdbAvailable] = useState(false)
    const [totalStoredCount, setTotalStoredCount] = useState(0)
    const dbRef = useRef<IDBDatabase | null>(null)
    const writeQueueRef = useRef<EventMessage[]>([])
    const countRef = useRef(0)
    const trimmingRef = useRef(false)
    const flushingRef = useRef<Promise<void> | null>(null)
    const warnedDropRef = useRef(false)
    const kickRef = useRef<ReturnType<typeof setTimeout> | null>(null)

    const trim = useCallback(async (db: IDBDatabase) => {
        if (trimmingRef.current) return
        trimmingRef.current = true
        try {
            const actual = await countAll(db)
            if (actual > MAX_STORED_EVENTS) await deleteOldest(db, actual - MAX_STORED_EVENTS)
            countRef.current = await countAll(db)
            setTotalStoredCount(countRef.current)
        } catch (e) {
            console.warn('[useEventStorage] Eviction failed:', e)
        } finally {
            trimmingRef.current = false
        }
    }, [])

    // One writer at a time: IndexedDB runs read-write transactions one after another anyway, so firing a new
    // transaction per batch only piles up pending transactions (each holding a copy of its events) behind a burst.
    // Callers share the in-flight run, which keeps draining the queue until it is empty.
    const flush = useCallback((): Promise<void> => {
        if (flushingRef.current) return flushingRef.current
        const run = (async () => {
            const db = dbRef.current
            if (!db) return
            while (writeQueueRef.current.length > 0) {
                const batch = writeQueueRef.current.splice(0, WRITE_BATCH)
                try {
                    await putBatch(db, batch)
                    countRef.current += batch.length
                    setTotalStoredCount(countRef.current)
                    if (countRef.current > MAX_STORED_EVENTS) void trim(db) // side effects live here, not inside a state updater
                    // Give the page a turn between transactions: cloning events into IndexedDB is synchronous work.
                    await new Promise<void>((resolve) => setTimeout(resolve, 0))
                } catch (e) {
                    console.warn('[useEventStorage] Flush failed:', e)
                    if ((e as DOMException)?.name === 'QuotaExceededError') {
                        writeQueueRef.current = []
                        setIdbAvailable(false)
                        window.dispatchEvent(new CustomEvent('idb-quota-exceeded'))
                        return
                    }
                }
            }
        })().finally(() => { flushingRef.current = null })
        flushingRef.current = run
        return run
    }, [trim])

    useEffect(() => {
        let cancelled = false
        openDB()
            .then(async (db) => {
                if (cancelled) return
                dbRef.current = db
                setIdbAvailable(true)
                countRef.current = await countAll(db)
                if (!cancelled) setTotalStoredCount(countRef.current)
            })
            .catch((e) => {
                console.warn('[useEventStorage] IDB unavailable, falling back to RAM-only mode:', e.message)
                setIdbAvailable(false)
            })

        const timer = setInterval(() => void flush(), FLUSH_INTERVAL_MS)
        return () => {
            cancelled = true
            clearInterval(timer)
            if (kickRef.current !== null) { clearTimeout(kickRef.current); kickRef.current = null }
            void flush()
        }
    }, [flush])

    /** Queues an event for batched writing; flushes right away once a batch is full. */
    const saveEvent = useCallback((event: EventMessage) => {
        if (!idbAvailable) return
        const queue = writeQueueRef.current
        queue.push(event)
        if (queue.length > MAX_PENDING_WRITES) {
            queue.splice(0, queue.length - MAX_PENDING_WRITES)
            if (!warnedDropRef.current) {
                warnedDropRef.current = true
                console.warn('[useEventStorage] Storage cannot keep up with the stream; the oldest unsaved events are not kept in history.')
            }
        }
        // Start writing from a timer, not from here: saveEvent runs inside the ingest frame, which must stay short.
        if (queue.length >= FLUSH_BATCH_SIZE && kickRef.current === null) {
            kickRef.current = setTimeout(() => { kickRef.current = null; void flush() }, 0)
        }
    }, [idbAvailable, flush])

    const loadHistory = useCallback(async (limit: number = MAX_STORED_EVENTS): Promise<EventMessage[]> => {
        const db = dbRef.current
        if (!db || !idbAvailable) return []
        try {
            await flush() // include what is still queued
            return await readAllNewestFirst(db, Math.min(limit, MAX_STORED_EVENTS))
        } catch (e) {
            console.warn('[useEventStorage] loadHistory failed:', e)
            return []
        }
    }, [idbAvailable, flush])

    const clearStorage = useCallback(async () => {
        const db = dbRef.current
        if (!db) return
        writeQueueRef.current = []
        await clearStore(db)
        countRef.current = 0
        setTotalStoredCount(0)
    }, [])

    return { idbAvailable, totalStoredCount, saveEvent, loadHistory, clearStorage }
}
