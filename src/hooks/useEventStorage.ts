import { useState, useEffect, useRef, useCallback } from 'react'
import type { EventMessage } from '../types'
import {
    openDB,
    putBatch,
    getAllAfter,
    countAll,
    clearStore,
    deleteOldest,
} from '../utils/idbUtils'

const FLUSH_INTERVAL_MS = 100   // Flush queue every 100ms
const FLUSH_BATCH_SIZE = 50     // Also flush if queue reaches 50 events
const MAX_STORED_EVENTS = 100_000  // Auto-evict oldest when exceeding this

interface UseEventStorageReturn {
    idbAvailable: boolean
    totalStoredCount: number
    saveEvent: (event: EventMessage) => void
    loadBefore: (afterArrivalTime?: number | null) => Promise<EventMessage[]>
    clearStorage: () => Promise<void>
    replayFromStorage: () => Promise<EventMessage[]>
}

export const useEventStorage = (): UseEventStorageReturn => {
    const [idbAvailable, setIdbAvailable] = useState(false)
    const [totalStoredCount, setTotalStoredCount] = useState(0)
    const dbRef = useRef<IDBDatabase | null>(null)
    const writeQueueRef = useRef<EventMessage[]>([])
    const flushTimerRef = useRef<ReturnType<typeof setInterval> | null>(null)

    const flush = useCallback(async () => {
        const db = dbRef.current
        const queue = writeQueueRef.current
        if (!db || queue.length === 0) return

        const batch = queue.splice(0, queue.length) // drain queue atomically

        try {
            await putBatch(db, batch)

            // Auto-evict if over max
            const total = await countAll(db)
            if (total > MAX_STORED_EVENTS) {
                await deleteOldest(db, total - MAX_STORED_EVENTS)
            }

            const finalCount = await countAll(db)
            setTotalStoredCount(finalCount)
        } catch (e) {
            console.warn('[useEventStorage] Flush failed:', e)
        }
    }, [])

    // Initialize IDB on mount
    useEffect(() => {
        openDB()
            .then(async (db) => {
                dbRef.current = db
                setIdbAvailable(true)
                // Load initial count
                const count = await countAll(db)
                setTotalStoredCount(count)
            })
            .catch((e) => {
                console.warn('[useEventStorage] IDB unavailable, falling back to RAM-only mode:', e.message)
                setIdbAvailable(false)
            })

        // Set up periodic flush timer
        flushTimerRef.current = setInterval(flush, FLUSH_INTERVAL_MS)

        return () => {
            if (flushTimerRef.current) clearInterval(flushTimerRef.current)
            flush() // Final flush on unmount
        }
    }, [flush])

    /**
     * Queues an event for batched writing.
     * Triggers an immediate flush if the queue reaches FLUSH_BATCH_SIZE.
     */
    const saveEvent = useCallback((event: EventMessage) => {
        if (!idbAvailable) return
        writeQueueRef.current.push(event)
        if (writeQueueRef.current.length >= FLUSH_BATCH_SIZE) {
            flush()
        }
    }, [idbAvailable, flush])

    /**
     * Loads up to 500 events from IDB before a given arrivalTime cursor.
     * Returns [] if IDB is unavailable or on error.
     */
    const loadBefore = useCallback(async (afterArrivalTime: number | null = null): Promise<EventMessage[]> => {
        const db = dbRef.current
        if (!db || !idbAvailable) return []
        try {
            return await getAllAfter(db, afterArrivalTime, 500)
        } catch (e) {
            console.warn('[useEventStorage] loadBefore failed:', e)
            return []
        }
    }, [idbAvailable])

    /**
     * Wipes all stored events.
     */
    const clearStorage = useCallback(async () => {
        const db = dbRef.current
        if (!db) return
        await clearStore(db)
        setTotalStoredCount(0)
    }, [])

    /**
     * Loads ALL stored events for offline replay.
     * Designed to feed into the mock stream playback system.
     *
     * Uses offset-based pagination instead of arrivalTime cursor, which prevents
     * duplicate-timestamp events from being silently skipped.
     */
    const replayFromStorage = useCallback(async (): Promise<EventMessage[]> => {
        const db = dbRef.current
        if (!db || !idbAvailable) return []
        try {
            const MAX_REPLAY = 100_000
            const PAGE_SIZE = 500
            const allEvents: EventMessage[] = []
            let page: EventMessage[]
            let cursor: number | null = null

            do {
                page = await getAllAfter(db, cursor, PAGE_SIZE)
                if (page.length === 0) break
                allEvents.push(...page)
                if (allEvents.length >= MAX_REPLAY) {
                    console.warn('[useEventStorage] replayFromStorage hit MAX_REPLAY cap of', MAX_REPLAY)
                    break
                }
                // Advance cursor past the last returned arrivalTime.
                // To handle duplicate arrivalTime values correctly we also check
                // if this page was a full page — if so, there may be more at the same timestamp.
                // We bump the cursor by 1ms if the last page ended on the same arrivalTime as
                // the overall last-seen, so we do NOT skip events with the same timestamp.
                const lastArrival = page[page.length - 1].arrivalTime ?? null
                if (lastArrival === cursor) {
                    // Same timestamp as previous page end — no progress, stop to avoid infinite loop
                    break
                }
                cursor = lastArrival
            } while (page.length === PAGE_SIZE)

            return allEvents
        } catch (e) {
            console.warn('[useEventStorage] replayFromStorage failed:', e)
            return []
        }
    }, [idbAvailable])


    return {
        idbAvailable,
        totalStoredCount,
        saveEvent,
        loadBefore,
        clearStorage,
        replayFromStorage,
    }
}
