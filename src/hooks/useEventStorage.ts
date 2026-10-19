import { useState, useEffect, useRef, useCallback } from 'react'
import type { EventMessage } from '../types'
import { openDB, putBatch, countAll, clearStore, deleteOldest, readAllNewestFirst } from '../utils/idbUtils'

const FLUSH_INTERVAL_MS = 100
const FLUSH_BATCH_SIZE = 50
export const MAX_STORED_EVENTS = 100_000

interface UseEventStorageReturn {
    idbAvailable: boolean
    totalStoredCount: number
    saveEvent: (event: EventMessage) => void
    /** Every stored event, newest first (capped at MAX_STORED_EVENTS). Resolves to [] when storage is unavailable. */
    loadHistory: () => Promise<EventMessage[]>
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

    const flush = useCallback(async () => {
        const db = dbRef.current
        const queue = writeQueueRef.current
        if (!db || queue.length === 0) return
        const batch = queue.splice(0, queue.length)

        try {
            await putBatch(db, batch)
            countRef.current += batch.length
            setTotalStoredCount(countRef.current)
            if (countRef.current > MAX_STORED_EVENTS) void trim(db) // side effects live here, not inside a state updater
        } catch (e) {
            console.warn('[useEventStorage] Flush failed:', e)
            if ((e as DOMException)?.name === 'QuotaExceededError') {
                setIdbAvailable(false)
                window.dispatchEvent(new CustomEvent('idb-quota-exceeded'))
            }
        }
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
            void flush()
        }
    }, [flush])

    /** Queues an event for batched writing; flushes right away once a batch is full. */
    const saveEvent = useCallback((event: EventMessage) => {
        if (!idbAvailable) return
        writeQueueRef.current.push(event)
        if (writeQueueRef.current.length >= FLUSH_BATCH_SIZE) void flush()
    }, [idbAvailable, flush])

    const loadHistory = useCallback(async (): Promise<EventMessage[]> => {
        const db = dbRef.current
        if (!db || !idbAvailable) return []
        try {
            await flush() // include what is still queued
            return await readAllNewestFirst(db, MAX_STORED_EVENTS)
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
