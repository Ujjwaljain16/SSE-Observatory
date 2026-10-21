/**
 * Captures saved in this browser, and the bookmarks a person made while looking at a stream. Their own IndexedDB database,
 * so nothing here touches the event storage.
 *
 * A saved capture is the recording as the app held it (a local-full capture, unredacted) and never leaves the browser
 * unless someone exports it through the redaction dialog. Limits keep the library from filling the disk.
 */

const DB_NAME = 'sse-doctor-db'
const DB_VERSION = 1 // not yet released, so the stores above are version 1
export const MAX_SAVED = 20
export const MAX_SAVED_BYTES = 20 * 1024 * 1024
export const MAX_BOOKMARKS_PER_CAPTURE = 200

export interface SavedCaptureMeta {
    id: string
    name: string
    savedAt: number
    bytes: number
    records: number
    /** Where the capture came from, for the list: a recording saved here, or a file opened. */
    origin: 'recording' | 'file'
}

export interface Bookmark {
    id: string
    /** The capture (or live recording id) the bookmark belongs to. */
    captureId: string
    label: string
    /** Time in the recording's clock, so it can be drawn on the timeline. */
    t: number
    createdAt: number
}

let dbPromise: Promise<IDBDatabase> | null = null

function open(): Promise<IDBDatabase> {
    dbPromise ??= new Promise<IDBDatabase>((resolve, reject) => {
        if (typeof indexedDB === 'undefined') { reject(new Error('Saving is not available in this browser (it has no IndexedDB, or it is blocked, as in some private windows).')); return }
        const request = indexedDB.open(DB_NAME, DB_VERSION)
        request.onupgradeneeded = () => {
            const db = request.result
            // The list is read often and the texts are large, so they live in a store of their own.
            db.createObjectStore('captures', { keyPath: 'id' })
            db.createObjectStore('texts')
            const marks = db.createObjectStore('bookmarks', { keyPath: 'id' })
            marks.createIndex('captureId', 'captureId', { unique: false })
        }
        request.onsuccess = () => {
            const db = request.result
            db.onversionchange = () => { db.close(); dbPromise = null }
            resolve(db)
        }
        request.onerror = () => { dbPromise = null; reject(new Error('Saving is not available in this browser.')) }
        request.onblocked = () => { dbPromise = null; reject(new Error('Another tab is holding the library open; close it and try again.')) }
    })
    return dbPromise
}

/** For tests: forget the open connection. */
export function resetLibrary(): void {
    dbPromise = null
}

const done = <T,>(request: IDBRequest<T>): Promise<T> => new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error ?? new Error('The browser refused the request.'))
})

const newId = (): string => (typeof crypto !== 'undefined' && 'randomUUID' in crypto ? crypto.randomUUID() : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`)

async function store<T>(name: 'captures' | 'bookmarks' | 'texts', mode: IDBTransactionMode, run: (s: IDBObjectStore) => Promise<T>): Promise<T> {
    const db = await open()
    return run(db.transaction(name, mode).objectStore(name))
}

export async function listCaptures(): Promise<SavedCaptureMeta[]> {
    const all = await store('captures', 'readonly', (s) => done(s.getAll() as IDBRequest<SavedCaptureMeta[]>))
    return all.sort((a, b) => b.savedAt - a.savedAt)
}

export async function saveCapture(input: { name: string; text: string; records: number; origin: SavedCaptureMeta['origin'] }): Promise<SavedCaptureMeta> {
    const bytes = new Blob([input.text]).size
    if (bytes > MAX_SAVED_BYTES) throw new Error(`That capture is ${(bytes / 1048576).toFixed(1)} MB; the library keeps captures up to ${MAX_SAVED_BYTES / 1048576} MB.`)
    if ((await listCaptures()).length >= MAX_SAVED) throw new Error(`The library holds ${MAX_SAVED} captures. Delete one to make room.`)
    const meta: SavedCaptureMeta = { id: newId(), name: input.name.trim().slice(0, 120) || 'Capture', savedAt: Date.now(), bytes, records: input.records, origin: input.origin }
    await store('texts', 'readwrite', (s) => done(s.add(input.text, meta.id)))
    await store('captures', 'readwrite', (s) => done(s.add(meta)))
    return meta
}

export async function readCaptureText(id: string): Promise<string | undefined> {
    return store('texts', 'readonly', (s) => done(s.get(id) as IDBRequest<string | undefined>))
}

export async function deleteCapture(id: string): Promise<void> {
    await store('captures', 'readwrite', (s) => done(s.delete(id)))
    await store('texts', 'readwrite', (s) => done(s.delete(id)))
    for (const mark of await listBookmarks(id)) await deleteBookmark(mark.id)
}

export async function listBookmarks(captureId: string): Promise<Bookmark[]> {
    const all = await store('bookmarks', 'readonly', (s) => done(s.index('captureId').getAll(captureId) as IDBRequest<Bookmark[]>))
    return all.sort((a, b) => a.t - b.t)
}

export async function addBookmark(input: { captureId: string; label: string; t: number }): Promise<Bookmark> {
    if ((await listBookmarks(input.captureId)).length >= MAX_BOOKMARKS_PER_CAPTURE) throw new Error(`A capture holds up to ${MAX_BOOKMARKS_PER_CAPTURE} bookmarks.`)
    const mark: Bookmark = { id: newId(), captureId: input.captureId, label: input.label.trim().slice(0, 200) || 'Bookmark', t: input.t, createdAt: Date.now() }
    await store('bookmarks', 'readwrite', (s) => done(s.add(mark)))
    return mark
}

export async function deleteBookmark(id: string): Promise<void> {
    await store('bookmarks', 'readwrite', (s) => done(s.delete(id)))
}
