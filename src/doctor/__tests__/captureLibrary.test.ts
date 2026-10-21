import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { MAX_BOOKMARKS_PER_CAPTURE, MAX_SAVED, addBookmark, deleteBookmark, deleteCapture, listBookmarks, listCaptures, readCaptureText, resetLibrary, saveCapture } from '../captureLibrary'
import { loadCaptureText, MAX_OPEN_BYTES } from '../loadCapture'
import { localCapture } from '../../core/capture/build'
import { serializeCapture } from '../../core/capture/format'
import type { CaptureRecord } from '../../core/capture/format'
import { healthyStart } from '../../core/testing/captureBuilder'

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
beforeEach(wipe)
afterEach(wipe)

const sample = () => serializeCapture(localCapture(healthyStart().frame('tick', '1').observations() as CaptureRecord[], { source: { kind: 'browser-app' }, request: { url: 'https://stream.test/e' } }))

describe('the capture library', () => {
    it('keeps what was saved, newest first, without loading every text to list them', async () => {
        const text = sample()
        const a = await saveCapture({ name: 'first', text, records: 5, origin: 'recording' })
        await new Promise((r) => setTimeout(r, 5))
        const b = await saveCapture({ name: 'second', text, records: 6, origin: 'file' })
        const list = await listCaptures()
        expect(list.map((c) => c.name)).toEqual(['second', 'first'])
        expect(list[0]).not.toHaveProperty('text')
        expect(await readCaptureText(a.id)).toBe(text)
        expect(b.origin).toBe('file')
    })

    it('deletes a capture and its bookmarks', async () => {
        const c = await saveCapture({ name: 'x', text: sample(), records: 1, origin: 'recording' })
        await addBookmark({ captureId: c.id, label: 'here', t: 100 })
        await deleteCapture(c.id)
        expect(await listCaptures()).toEqual([])
        expect(await readCaptureText(c.id)).toBeUndefined()
        expect(await listBookmarks(c.id)).toEqual([])
    })

    it('refuses what would fill the disk, saying why', async () => {
        await expect(saveCapture({ name: 'big', text: 'x'.repeat(21 * 1024 * 1024), records: 1, origin: 'file' })).rejects.toThrow(/20 MB/)
        for (let i = 0; i < MAX_SAVED; i++) await saveCapture({ name: `c${i}`, text: 'x', records: 1, origin: 'file' })
        await expect(saveCapture({ name: 'one more', text: 'x', records: 1, origin: 'file' })).rejects.toThrow(/holds 20 captures/)
    }, 30_000)

    it('names an unnamed capture and trims a long name', async () => {
        expect((await saveCapture({ name: '   ', text: 'x', records: 1, origin: 'file' })).name).toBe('Capture')
        expect((await saveCapture({ name: 'n'.repeat(500), text: 'x', records: 1, origin: 'file' })).name).toHaveLength(120)
    })
})

describe('bookmarks', () => {
    it('are listed in order of time, per capture, and can be removed', async () => {
        await addBookmark({ captureId: 'a', label: 'late', t: 900 })
        const early = await addBookmark({ captureId: 'a', label: 'early', t: 100 })
        await addBookmark({ captureId: 'b', label: 'other', t: 5 })
        expect((await listBookmarks('a')).map((m) => m.label)).toEqual(['early', 'late'])
        await deleteBookmark(early.id)
        expect((await listBookmarks('a')).map((m) => m.label)).toEqual(['late'])
        expect(await listBookmarks('b')).toHaveLength(1)
    })

    it('are limited per capture', async () => {
        for (let i = 0; i < MAX_BOOKMARKS_PER_CAPTURE; i++) await addBookmark({ captureId: 'a', label: `m${i}`, t: i })
        await expect(addBookmark({ captureId: 'a', label: 'extra', t: 1 })).rejects.toThrow(/up to 200/)
    }, 30_000)
})

describe('opening a file', () => {
    it('reads an .sse-capture, with its integrity check', () => {
        const r = loadCaptureText(sample())
        expect(r.ok && r.format).toBe('sse-capture')
        expect(r.ok && r.integrity).toBe('ok')
    })

    it('tolerates a byte order mark and CRLF line endings, as an editor or PowerShell may leave them', () => {
        const r = loadCaptureText('﻿' + sample().replace(/\n/g, '\r\n'))
        expect(r.ok && r.integrity).toBe('ok')
    })

    it('says a tampered file does not match its hash, and still reads it', () => {
        const lines = sample().split('\n')
        lines[2] = lines[2]!.replace(/"t":\d+/, '"t":999999')
        const r = loadCaptureText(lines.join('\n'))
        expect(r.ok && r.integrity).toBe('mismatch')
    })

    it('imports an older .sse-record recording and says what it cannot show', () => {
        const v1 = JSON.stringify({ version: '1.0', events: [{ id: '1', type: 'tick', data: '{"n":1}', deltaMs: 0 }, { id: '2', type: 'tick', data: '{"n":2}', deltaMs: 500 }] })
        const r = loadCaptureText(v1)
        expect(r.ok && r.format).toBe('sse-record')
        expect(r.ok && r.warnings.join(' ')).toMatch(/not evaluated/)
    })

    it.each([
        ['', /empty/],
        ['   \n ', /empty/],
        ['not json at all', /not a capture/],
        ['{"hello":"world"}', /not a capture or a recording/],
        ['[1,2,3]', /not a capture or a recording/],
        ['{"format":"sse-capture","version":"9.0"}', /./],
    ])('refuses %j with a reason', (text, message) => {
        const r = loadCaptureText(text)
        expect(r.ok).toBe(false)
        expect(!r.ok && r.error).toMatch(message)
    })

    it('refuses a file over the limit without reading it', () => {
        const r = loadCaptureText('{}', MAX_OPEN_BYTES + 1)
        expect(!r.ok && r.error).toMatch(/20.\d MB/)
    })
})
