import type { EventMessage } from '../types'

export const DB_NAME = 'sse-tester-db'
// v1: events keyed by id, index "arrivalTime".
// v2: adds index "order" = [arrivalTime, seq] so events that share a millisecond keep a total order and can
//     be paged without skipping or repeating any; old records get a seq during the upgrade.
const DB_VERSION = 2
const STORE_NAME = 'events'

let dbPromise: Promise<IDBDatabase> | null = null

/** Position of an event in storage order; pass the last event of a page to get the next page. */
export interface StoreCursor {
    arrivalTime: number
    seq: number
}

export const cursorOf = (e: Pick<EventMessage, 'arrivalTime' | 'seq'>): StoreCursor | null =>
    e.arrivalTime === undefined ? null : { arrivalTime: e.arrivalTime, seq: e.seq ?? 0 }

export const openDB = (): Promise<IDBDatabase> => {
    if (dbPromise) return dbPromise

    dbPromise = new Promise<IDBDatabase>((resolve, reject) => {
        try {
            const request = indexedDB.open(DB_NAME, DB_VERSION)

            request.onupgradeneeded = (e) => {
                const db = request.result
                const tx = request.transaction!
                const oldVersion = e.oldVersion
                const store = db.objectStoreNames.contains(STORE_NAME)
                    ? tx.objectStore(STORE_NAME)
                    : db.createObjectStore(STORE_NAME, { keyPath: 'id', autoIncrement: false })
                if (!store.indexNames.contains('arrivalTime')) store.createIndex('arrivalTime', 'arrivalTime', { unique: false })

                if (oldVersion < 2) {
                    // Give pre-existing records a seq (in arrival order), then index them.
                    let seq = 0
                    const cursorReq = store.index('arrivalTime').openCursor()
                    cursorReq.onsuccess = () => {
                        const cursor = cursorReq.result
                        if (!cursor) return
                        const value = cursor.value
                        value.seq = value.seq ?? ++seq
                        cursor.update(value)
                        cursor.continue()
                    }
                }
                if (!store.indexNames.contains('order')) store.createIndex('order', ['arrivalTime', 'seq'], { unique: false })
            }

            request.onsuccess = () => {
                const db = request.result
                // Another tab wants to upgrade/delete the database: release our connection so it is not blocked.
                db.onversionchange = () => { db.close(); dbPromise = null }
                db.onclose = () => { dbPromise = null }
                resolve(db)
            }

            request.onerror = () => {
                dbPromise = null
                reject(new Error(`IDB open failed: ${request.error?.message}`))
            }

            request.onblocked = () => {
                // Another tab still holds an older version open. It will close on versionchange; keep waiting.
                console.warn('[IDB] Database upgrade blocked by another connection. Close other tabs to proceed.')
            }
        } catch (e) {
            dbPromise = null
            reject(new Error(`IDB not available: ${(e as Error).message}`))
        }
    })
    return dbPromise
}

export const resetDBInstance = () => {
    dbPromise = null
}

const txDone = (tx: IDBTransaction): Promise<void> =>
    new Promise((resolve, reject) => {
        tx.oncomplete = () => resolve()
        tx.onerror = () => reject(tx.error)
        tx.onabort = () => reject(tx.error ?? new DOMException('Transaction aborted', 'AbortError'))
    })

/** Rebuilds the derived search index that putBatch leaves out. */
const restore = (e: EventMessage): EventMessage => {
    if (e._searchIndex === undefined) e._searchIndex = (typeof e.data === 'string' ? e.data : JSON.stringify(e.data)).toLowerCase()
    return e
}

export const putBatch = async (db: IDBDatabase, events: EventMessage[]): Promise<void> => {
    if (events.length === 0) return
    const tx = db.transaction(STORE_NAME, 'readwrite')
    const done = txDone(tx)
    try {
        const store = tx.objectStore(STORE_NAME)
        const now = Date.now()
        for (const event of events) {
            // _searchIndex is a lowercase copy of data: not stored (it is rebuilt on read), which keeps writes small
            const { _searchIndex: _omit, ...record } = event
            store.put({ ...record, arrivalTime: event.arrivalTime ?? now, seq: event.seq ?? 0 })
        }
    } catch (e) {
        try { tx.abort() } catch { /* already finished */ }
        done.catch(() => undefined)
        throw e
    }
    await done
}

/**
 * Reads up to `limit` events in storage order starting after `after` (null = from the start).
 * direction 'prev' walks backwards (newest first), which is how "older than this" pages are read.
 */
export const getPage = (
    db: IDBDatabase,
    after: StoreCursor | null = null,
    limit = 500,
    direction: 'next' | 'prev' = 'next'
): Promise<EventMessage[]> => {
    return new Promise((resolve, reject) => {
        const tx = db.transaction(STORE_NAME, 'readonly')
        const index = tx.objectStore(STORE_NAME).index('order')
        const key = after ? [after.arrivalTime, after.seq] : null
        const range = key === null ? null : direction === 'next' ? IDBKeyRange.lowerBound(key, true) : IDBKeyRange.upperBound(key, true)

        const results: EventMessage[] = []
        const request = index.openCursor(range, direction)
        request.onsuccess = () => {
            const cursor = request.result
            if (cursor && results.length < limit) {
                results.push(restore(cursor.value as EventMessage))
                cursor.continue()
            } else {
                resolve(results)
            }
        }
        request.onerror = () => reject(request.error)
    })
}

/** Legacy arrival-time paging (exclusive lower bound). Prefer getPage: this skips events that share a millisecond. */
export const getAllAfter = (
    db: IDBDatabase,
    afterArrivalTime: number | null = null,
    limit: number = 500
): Promise<EventMessage[]> => {
    return new Promise((resolve, reject) => {
        const tx = db.transaction(STORE_NAME, 'readonly')
        const index = tx.objectStore(STORE_NAME).index('arrivalTime')
        const range = afterArrivalTime !== null ? IDBKeyRange.lowerBound(afterArrivalTime, true) : null

        const results: EventMessage[] = []
        const request = index.openCursor(range, 'next')
        request.onsuccess = () => {
            const cursor = request.result
            if (cursor && results.length < limit) {
                results.push(restore(cursor.value as EventMessage))
                cursor.continue()
            } else {
                resolve(results)
            }
        }
        request.onerror = () => reject(request.error)
    })
}

export const countAll = (db: IDBDatabase): Promise<number> => {
    return new Promise((resolve, reject) => {
        const request = db.transaction(STORE_NAME, 'readonly').objectStore(STORE_NAME).count()
        request.onsuccess = () => resolve(request.result)
        request.onerror = () => reject(request.error)
    })
}

export const clearStore = async (db: IDBDatabase): Promise<void> => {
    const tx = db.transaction(STORE_NAME, 'readwrite')
    const done = txDone(tx)
    tx.objectStore(STORE_NAME).clear()
    await done
}

/** Deletes the `count` oldest events (by arrival order). */
export const deleteOldest = async (db: IDBDatabase, count: number): Promise<void> => {
    const tx = db.transaction(STORE_NAME, 'readwrite')
    const done = txDone(tx)
    let deleted = 0
    const request = tx.objectStore(STORE_NAME).index('order').openCursor(null, 'next')
    request.onsuccess = () => {
        const cursor = request.result
        if (cursor && deleted < count) {
            cursor.delete()
            deleted++
            cursor.continue()
        }
    }
    await done
}

/** Reads every stored event, newest first, up to `max`. Pages through the compound index, so nothing is skipped. */
export async function readAllNewestFirst(db: IDBDatabase, max = 100_000, pageSize = 500): Promise<EventMessage[]> {
    const out: EventMessage[] = []
    let cursor: StoreCursor | null = null
    while (out.length < max) {
        const page = await getPage(db, cursor, Math.min(pageSize, max - out.length), 'prev')
        if (page.length === 0) break
        out.push(...page)
        const last = page[page.length - 1]
        cursor = { arrivalTime: last.arrivalTime ?? 0, seq: last.seq ?? 0 }
        if (page.length < pageSize) break
    }
    return out
}
