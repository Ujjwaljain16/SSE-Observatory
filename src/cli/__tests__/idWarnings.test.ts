import { describe, expect, it } from 'vitest'
import { main, EXIT, type CliIo } from '../index'
import { newHeader, serializeCapture } from '../../core/capture/format'
import { bytesToBase64 } from '../../core/capture/base64'

// Issue 78: `sse-doctor report` on a capture of the public Wikimedia stream (468 events, ids that are JSON arrays) printed 462 warning lines.

function host(files: Record<string, string>) {
    const written: Record<string, string> = {}
    let out = ''
    let err = ''
    const io: CliIo = {
        out: (t) => { out += t }, err: (t) => { err += t },
        readText: async (p) => { if (p in files) return files[p]!; throw new Error('ENOENT') },
        writeText: async (p, t) => { written[p] = t; files[p] = t },
        env: {},
    }
    return { io, written, get out() { return out }, get err() { return err } }
}

const captureOfIds = (ids: string[]): string => {
    const bytes = new TextEncoder().encode(ids.map((id, i) => `id: ${id}\nevent: message\ndata: {"n":${i}}\n\n`).join(''))
    return serializeCapture({
        header: newHeader({ kind: 'local-full', source: { kind: 'fixture' }, request: { url: 'http://x.test/s', method: 'GET', headers: {} } }),
        records: [
            { seq: 0, t: 0, conn: 0, kind: 'connect', attempt: 0, url: 'http://x.test/s', method: 'GET', headerNames: ['accept'], sentLastEventId: '' },
            { seq: 1, t: 5, conn: 0, kind: 'response', status: 200, contentType: 'text/event-stream', redirected: false, headers: { 'content-type': 'text/event-stream' }, ttfbMs: 5 },
            { seq: 2, t: 10, conn: 0, kind: 'chunk', bytes: bytes.length, b64: bytesToBase64(bytes) },
        ],
    })
}

const wikimediaId = (i: number): string => JSON.stringify([
    { topic: 'eqiad.mediawiki.recentchange', partition: 0, offset: -1 },
    { topic: 'codfw.mediawiki.recentchange', partition: 0, timestamp: 1794769472912 + i },
])
const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789'
const tokenOf = (i: number): string => {
    let s = 'k' + i
    for (let j = 0; s.length < 32; j++) s += ALPHABET[(i * 7919 + j * 104729 + j * j * 31) % ALPHABET.length]
    return s
}
const lines = (text: string): string[] => text.split('\n').filter((l) => l.trim() !== '')
// the warning about event ids (the residual scan has its own, separate, already capped warning about the stream text)
const idLines = (text: string): string[] => lines(text).filter((l) => /event ids? /.test(l))

describe('event id warnings on the command line', () => {
    it('report on 468 Wikimedia style events prints no warning at all', async () => {
        const h = host({ 'wiki.sse-capture': captureOfIds(Array.from({ length: 468 }, (_, i) => wikimediaId(i))) })
        expect(await main(['report', 'wiki.sse-capture', '--redact', '--format', 'md', '--output', 'r.md'], h.io)).toBe(EXIT.ok)
        expect(lines(h.err)).toEqual([])
        expect(h.written['r.md']).toContain('# SSE Observatory report')
    })

    it('report on 50 random ids prints exactly one event id warning line, which counts them and never shows an id', async () => {
        const tokens = Array.from({ length: 50 }, (_, i) => tokenOf(i))
        const h = host({ 'tok.sse-capture': captureOfIds(tokens) })
        expect(await main(['report', 'tok.sse-capture', '--redact', '--format', 'md', '--output', 'r.md'], h.io)).toBe(EXIT.ok)
        expect(idLines(h.err)).toEqual(['warning: 50 event ids look like random tokens but match no known secret format, so they were kept; check them before sharing (first: event id #1)'])
        for (const t of tokens) expect(h.err).not.toContain(t)
    })

    it('redact prints the same single line for the same capture, and none for structured ids', async () => {
        const tokens = Array.from({ length: 50 }, (_, i) => tokenOf(i))
        const a = host({ 'tok.sse-capture': captureOfIds(tokens) })
        expect(await main(['redact', 'tok.sse-capture', '--output', 'out.sse-capture'], a.io)).toBe(EXIT.ok)
        expect(idLines(a.err)).toHaveLength(1)
        expect(a.err).toContain('50 event ids look like random tokens')
        const b = host({ 'wiki.sse-capture': captureOfIds(Array.from({ length: 468 }, (_, i) => wikimediaId(i))) })
        expect(await main(['redact', 'wiki.sse-capture', '--output', 'out.sse-capture'], b.io)).toBe(EXIT.ok)
        expect(lines(b.err)).toEqual([])
    })
})
