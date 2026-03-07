import type { EventMessage } from '../types'

const DB_NAME = 'sse-tester-db'
const DB_VERSION = 1
const STORE_NAME = 'events'

let dbInstance: IDBDatabase | null = null


export const openDB = (): Promise<IDBDatabase> => {
    if (dbInstance) return Promise.resolve(dbInstance)

    return new Promise((resolve, reject) => {
        try {
            const request = indexedDB.open(DB_NAME, DB_VERSION)

            request.onupgradeneeded = (e) => {
                const db = (e.target as IDBOpenDBRequest).result
                if (!db.objectStoreNames.contains(STORE_NAME)) {
                    const store = db.createObjectStore(STORE_NAME, { keyPath: 'id', autoIncrement: false })
                    // Index by arrivalTime for ordered pagination
                    store.createIndex('arrivalTime', 'arrivalTime', { unique: false })
                }
            }

            request.onsuccess = (e) => {
                dbInstance = (e.target as IDBOpenDBRequest).result
                resolve(dbInstance!)
            }

            request.onerror = (e) => {
                reject(new Error(`IDB open failed: ${(e.target as IDBOpenDBRequest).error?.message}`))
            }

            request.onblocked = () => {
                // onblocked fires when another tab/connection holds an older DB version open.
                // Rejecting here would permanently disable IDB for this tab — instead, warn
                // and let the IDB upgrade proceed once the other connection closes.
                console.warn('[IDB] Database upgrade blocked by another connection. Close other tabs to proceed.')
            }
        } catch (e: any) {
            reject(new Error(`IDB not available: ${e.message}`))
        }
    })
}

export const resetDBInstance = () => {
    dbInstance = null
}

export const putBatch = (db: IDBDatabase, events: EventMessage[]): Promise<void> => {
    return new Promise((resolve, reject) => {
        if (events.length === 0) return resolve()

        const tx = db.transaction(STORE_NAME, 'readwrite')
        const store = tx.objectStore(STORE_NAME)

        for (const event of events) {
            store.put({ ...event, _indexed: event.arrivalTime ?? Date.now() })
        }

        tx.oncomplete = () => resolve()
        tx.onerror = () => reject(tx.error)
    })
}

export const getAllAfter = (
    db: IDBDatabase,
    afterArrivalTime: number | null = null,
    limit: number = 500
): Promise<EventMessage[]> => {
    return new Promise((resolve, reject) => {
        const tx = db.transaction(STORE_NAME, 'readonly')
        const store = tx.objectStore(STORE_NAME)
        const index = store.index('arrivalTime')
        const range = afterArrivalTime !== null
            ? IDBKeyRange.lowerBound(afterArrivalTime, true)
            : null

        const results: EventMessage[] = []
        const request = index.openCursor(range, 'next')

        request.onsuccess = (e) => {
            const cursor = (e.target as IDBRequest<IDBCursorWithValue | null>).result
            if (cursor && results.length < limit) {
                results.push(cursor.value as EventMessage)
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
        const tx = db.transaction(STORE_NAME, 'readonly')
        const store = tx.objectStore(STORE_NAME)
        const request = store.count()
        request.onsuccess = () => resolve(request.result)
        request.onerror = () => reject(request.error)
    })
}

export const clearStore = (db: IDBDatabase): Promise<void> => {
    return new Promise((resolve, reject) => {
        const tx = db.transaction(STORE_NAME, 'readwrite')
        const store = tx.objectStore(STORE_NAME)
        const request = store.clear()
        tx.oncomplete = () => resolve()
        request.onerror = () => reject(request.error)
    })
}

export const deleteOldest = (db: IDBDatabase, count: number): Promise<void> => {
    return new Promise((resolve, reject) => {
        const tx = db.transaction(STORE_NAME, 'readwrite')
        const store = tx.objectStore(STORE_NAME)
        const index = store.index('arrivalTime')
        let deleted = 0

        const request = index.openCursor(null, 'next')
        request.onsuccess = (e) => {
            const cursor = (e.target as IDBRequest<IDBCursorWithValue | null>).result
            if (cursor && deleted < count) {
                cursor.delete()
                deleted++
                cursor.continue()
            }
        }

        tx.oncomplete = () => resolve()
        tx.onerror = () => reject(tx.error)
    })
}
