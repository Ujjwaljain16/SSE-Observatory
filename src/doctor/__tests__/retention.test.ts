import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { addBookmark, deleteAllCaptures, listBookmarks, listCaptures, pruneOlderThan, resetLibrary, saveCapture } from '../captureLibrary'
import { RETENTION_CHOICES, libraryRetentionDays, setLibraryRetentionDays } from '../recordingConfig'
import { applyRetention } from '../retention'

async function wipe() {
    resetLibrary()
    await new Promise<void>((resolve) => {
        const req = indexedDB.deleteDatabase('sse-doctor-db')
        req.onsuccess = () => resolve()
        req.onerror = () => resolve()
        req.onblocked = () => resolve()
    })
    resetLibrary()
}
beforeEach(async () => { localStorage.clear(); await wipe() })
afterEach(async () => { vi.useRealTimers(); await wipe() })

const DAY = 86_400_000
const save = (name: string) => saveCapture({ name, text: '{"format":"sse-capture"}\n', records: 1, origin: 'recording' })

describe('how long saved captures are kept', () => {
    it('offers only the choices it has, and ignores anything else that is stored', () => {
        expect(libraryRetentionDays()).toBe(0)
        for (const days of RETENTION_CHOICES) { setLibraryRetentionDays(days); expect(libraryRetentionDays()).toBe(days) }
        setLibraryRetentionDays(12) // not a choice: refused
        expect(libraryRetentionDays()).toBe(90)
        for (const junk of ['-5', 'abc', '1.5', '999']) { localStorage.setItem('sse.library.retentionDays', junk); expect(libraryRetentionDays(), junk).toBe(0) }
    })

    it('deletes a capture older than the time chosen, with its bookmarks, and keeps a newer one', async () => {
        vi.useFakeTimers({ toFake: ['Date'], now: Date.now() - 8 * DAY }) // saved eight days ago
        const old = await save('old')
        vi.useRealTimers()
        const fresh = await save('fresh')
        await addBookmark({ captureId: old.id, label: 'mark', t: 5 })
        await addBookmark({ captureId: fresh.id, label: 'keep me', t: 5 })

        expect(await pruneOlderThan(7)).toBe(1)
        expect((await listCaptures()).map((c) => c.name)).toEqual(['fresh'])
        expect(await listBookmarks(old.id)).toHaveLength(0)
        expect(await listBookmarks(fresh.id)).toHaveLength(1)
    })

    it('keeps a capture that is younger than the limit, and everything when the limit is 0', async () => {
        await save('a')
        expect(await pruneOlderThan(7, Date.now() + 6 * DAY)).toBe(0)
        expect(await pruneOlderThan(0, Date.now() + 400 * DAY)).toBe(0)
        expect(await listCaptures()).toHaveLength(1)
    })

    it('deletes every capture and bookmark on request, and says how many', async () => {
        const a = await save('a')
        await save('b')
        await addBookmark({ captureId: a.id, label: 'mark', t: 5 })
        expect(await deleteAllCaptures()).toBe(2)
        expect(await listCaptures()).toHaveLength(0)
        expect(await listBookmarks(a.id)).toHaveLength(0)
        expect(await deleteAllCaptures()).toBe(0)
    })

    it('applies the choice at start, and does nothing (not even opening the library) when none was made', async () => {
        await save('a')
        expect(await applyRetention()).toBe(0) // never delete: no choice
        expect(await listCaptures()).toHaveLength(1)

        setLibraryRetentionDays(7)
        vi.useFakeTimers({ toFake: ['Date'], now: Date.now() + 8 * DAY })
        expect(await applyRetention()).toBe(1)
        vi.useRealTimers()
        expect(await listCaptures()).toHaveLength(0)
    })
})
