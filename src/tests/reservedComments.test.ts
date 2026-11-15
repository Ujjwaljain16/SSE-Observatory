// @vitest-environment node
import { describe, expect, it } from 'vitest'
import fc from 'fast-check'
import { FrameTracker } from '../../lib/proxy/guard.js'
import { NamespaceEscaper, UPSTREAM_ESCAPE } from '../../lib/proxy/diagTags.js'
import { SSEParser } from '../core/sse/sseParser'
import { parseBytes } from '../core/testing/refSseParser'

// Q15: the reserved comment namespace (`sse-proxy`) belongs to the proxy. The client labels a comment as the proxy's when its text starts
// with it, so a comment of the UPSTREAM that starts that way must not reach the client unchanged. The escaper rewrites such a line (and only
// such a line) by inserting UPSTREAM_ESCAPE (" upstream:") right after the colon, so ": sse-proxy hb up_idle=9 n=1" becomes
// ": upstream: sse-proxy hb up_idle=9 n=1": the same bytes plus a marker, no longer in the namespace, the same number of lines.

const enc = (s: string) => Buffer.from(s, 'utf8')

/** Whole-stream escape: every chunk, then the flush. */
function escapeChunks(chunks: Array<string | Uint8Array>): Buffer {
    const e = new NamespaceEscaper()
    const out: Buffer[] = chunks.map((c) => e.push(typeof c === 'string' ? enc(c) : Buffer.from(c)))
    out.push(e.flush())
    return Buffer.concat(out)
}
const escapeAll = (s: string | Uint8Array): Buffer => escapeChunks([s])

/** What the client does with a comment: the text after the colon and ONE optional space; it is the proxy's when that starts with "sse-proxy". */
function labelledProxy(wire: Buffer): string[] {
    const labelled: string[] = []
    const parser = new SSEParser({ onMessage: () => {}, onComment: (text) => { if (text.startsWith('sse-proxy')) labelled.push(text) } })
    parser.feed(wire)
    parser.end(false)
    return labelled
}

describe('what is rewritten (each form a forging upstream could use)', () => {
    const rewritten: Array<[string, string, string]> = [
        ['colon, space, tag', ': sse-proxy hb up_idle=900 n=1\n\n', ': upstream: sse-proxy hb up_idle=900 n=1\n\n'],
        ['no space after the colon', ':sse-proxy hb up_idle=900 n=1\n\n', ': upstream:sse-proxy hb up_idle=900 n=1\n\n'],
        ['more than one space', ':   sse-proxy hb up_idle=900 n=1\n\n', ': upstream:   sse-proxy hb up_idle=900 n=1\n\n'],
        ['a tab', ':\tsse-proxy hb up_idle=900 n=1\n\n', ': upstream:\tsse-proxy hb up_idle=900 n=1\n\n'],
        ['upper case', ': SSE-PROXY hb up_idle=900 n=1\n\n', ': upstream: SSE-PROXY hb up_idle=900 n=1\n\n'],
        ['mixed case', ': Sse-Proxy-Ping\n\n', ': upstream: Sse-Proxy-Ping\n\n'],
        ['the ping and meta forms', ': sse-proxy-ping\n\n: sse-proxy-meta {"status":200}\n\n', ': upstream: sse-proxy-ping\n\n: upstream: sse-proxy-meta {"status":200}\n\n'],
        ['the cap and error forms', ': sse-proxy cap duration=1\n\n: sse-proxy error {"error":"x"}\n\n', ': upstream: sse-proxy cap duration=1\n\n: upstream: sse-proxy error {"error":"x"}\n\n'],
        ['anything that merely starts with the namespace', ': sse-proxyfoo\n\n', ': upstream: sse-proxyfoo\n\n'],
        ['the bare namespace at the end of the stream, with no line ending', ': sse-proxy', ': upstream: sse-proxy'],
        ['a CR line ending', ': sse-proxy hb up_idle=9 n=1\r\r', ': upstream: sse-proxy hb up_idle=9 n=1\r\r'],
        ['a CRLF line ending', ': sse-proxy hb up_idle=9 n=1\r\n\r\n', ': upstream: sse-proxy hb up_idle=9 n=1\r\n\r\n'],
        ['a comment line in the middle of an event', 'id: 1\n: sse-proxy hb up_idle=9 n=1\ndata: a\n\n', 'id: 1\n: upstream: sse-proxy hb up_idle=9 n=1\ndata: a\n\n'],
        ['each line of a block of comments, not only the first', ': one\n: sse-proxy hb up_idle=9 n=1\n: two\n:sse-proxy cap duration=1\n\n', ': one\n: upstream: sse-proxy hb up_idle=9 n=1\n: two\n: upstream:sse-proxy cap duration=1\n\n'],
        ['the line after a lone CR', 'data: a\r: sse-proxy hb up_idle=9 n=1\r\r', 'data: a\r: upstream: sse-proxy hb up_idle=9 n=1\r\r'],
        ['the first line after a byte order mark (the parser strips a leading one)', '\uFEFF: sse-proxy hb up_idle=9 n=1\n\n', '\uFEFF: upstream: sse-proxy hb up_idle=9 n=1\n\n'],
    ]
    for (const [name, input, expected] of rewritten) {
        it(`${name}`, () => {
            const out = escapeAll(input)
            expect(out.toString('utf8')).toBe(expected)
            expect(labelledProxy(out), 'the client no longer labels any of it as the proxy\'s').toEqual([])
            // the forms the client itself labels as the proxy's (a colon, at most one space, lower case) really were labelled before; the others are rewritten
            // as well, because the namespace is reserved however it is spelled, but the client would not have been fooled by them today
            // (an unterminated last line is never a comment to the parser, so it is only checked when the stream ends with a line ending)
            if (/(^|[\r\n])﻿?: ?sse-proxy/.test(input) && /[\r\n]$/.test(input)) expect(labelledProxy(enc(input)).length, 'the input really was labelled proxy before').toBeGreaterThan(0)
        })
    }
})

describe('what is left alone, byte for byte', () => {
    const untouched: Array<[string, string | Uint8Array]> = [
        ['an ordinary keep-alive comment', ': keep-alive\n\n'],
        ['a comment that only looks similar (sse-prox, ssx-proxy, a letter before)', ': sse-prox\n\n: ssx-proxy\n\n: x sse-proxy\n\n'],
        ['the tag later in the comment, not at its start', ': note: sse-proxy is a word\n\n'],
        ['the tag in a data line, an event name or an id (not comments)', 'event: sse-proxy\nid: sse-proxy\ndata: : sse-proxy hb up_idle=9 n=1\n\n'],
        ['a line that has the tag but is not a comment', 'sse-proxy hb up_idle=9 n=1\n\n'],
        ['a colon inside a field line', 'data:sse-proxy\n\n'],
        ['an already escaped comment (the escape is not applied twice)', ': upstream: sse-proxy hb up_idle=9 n=1\n\n'],
        ['a lone colon and an empty comment', ':\n:\n\n'],
        ['a byte order mark in the middle of the stream: that line is not a comment', 'data: a\n\n\uFEFF: sse-proxy hb up_idle=9 n=1\n\n'],
        ['non-ASCII text', ': caf\u00e9\n\n'],
        ['invalid UTF-8 bytes', Uint8Array.from([0xff, 0xfe, 0x3a, 0x20, 0x73, 0x0a, 0x0a, 0x3a, 0xc3, 0x0a])],
        ['events with every line ending', 'id: 1\r\ndata: a\r\n\r\nid: 2\rdata: b\r\rdata: c\n\n'],
        ['more white space after the colon than the escaper looks past (the client does not label it either)', `:${' '.repeat(200)}sse-proxy\n\n`],
        ['the empty stream', ''],
    ]
    for (const [name, input] of untouched) {
        it(`${name}`, () => {
            const bytes = typeof input === 'string' ? enc(input) : Buffer.from(input)
            expect(escapeAll(bytes).equals(bytes), name).toBe(true)
            expect(labelledProxy(bytes), 'nothing here was labelled proxy before either').toEqual([])
        })
    }
})

describe('a comment split across network chunks', () => {
    const forged = ': sse-proxy hb up_idle=900 n=1\n\n'
    const expected = ': upstream: sse-proxy hb up_idle=900 n=1\n\n'
    it('is rewritten however it is cut: every single cut point, and one byte at a time', () => {
        for (let cut = 1; cut < forged.length; cut++) expect(escapeChunks([forged.slice(0, cut), forged.slice(cut)]).toString(), `cut at ${cut}`).toBe(expected)
        expect(escapeChunks([...forged]).toString()).toBe(expected)
    })
    it('holds back only what it cannot decide yet, and forwards everything else at once', () => {
        const e = new NamespaceEscaper()
        expect(e.push(enc('data: a\n\n')).toString()).toBe('data: a\n\n') // not a comment: no delay at all
        expect(e.push(enc(':')).toString()).toBe('') // might be the start of the namespace
        expect(e.push(enc(' sse-pro')).toString()).toBe('')
        expect(e.push(enc('xy no')).toString()).toBe(': upstream: sse-proxy no') // decided: the held bytes leave with the marker
        expect(e.push(enc('te\n\n')).toString()).toBe('te\n\n')
    })
    it('a line that turns out not to be the namespace is released unchanged as soon as it is known', () => {
        const e = new NamespaceEscaper()
        expect(e.push(enc(': sse-pr')).toString()).toBe('')
        expect(e.push(enc('ice list\n\n')).toString()).toBe(': sse-price list\n\n')
        expect(e.flush().length).toBe(0)
    })
    it('a CRLF cut between the CR and the LF does not change anything', () => {
        expect(escapeChunks([': sse-proxy x\r', '\n\r', '\n']).toString()).toBe(': upstream: sse-proxy x\r\n\r\n')
        expect(escapeChunks(['data: a\r', '\n: sse-proxy x\r\n\r\n']).toString()).toBe('data: a\r\n: upstream: sse-proxy x\r\n\r\n')
    })
    it('a byte order mark cut in two, then the forged comment', () => {
        const bytes = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), enc(': sse-proxy x\n\n')])
        expect(escapeChunks([bytes.subarray(0, 2), bytes.subarray(2)]).toString('utf8')).toBe('\uFEFF: upstream: sse-proxy x\n\n')
    })
    it('what is held when the stream ends is released unchanged by flush (the upstream\'s own bytes are never dropped)', () => {
        const e = new NamespaceEscaper()
        expect(e.push(enc('data: a\n\n: sse-pr')).toString()).toBe('data: a\n\n')
        expect(e.flush().toString()).toBe(': sse-pr')
        expect(e.flush().length).toBe(0)
    })
})

describe('properties (the specification\'s own parser, and a line-by-line oracle, as the judges)', () => {
    const word = fc.constantFrom('', 'a', 'x y', 'sse-proxy', 'sse-proxy hb up_idle=9 n=1', 'SSE-Proxy', 'sse-prox', ' sse-proxy', 'upstream: sse-proxy', '\u00e9')
    const sep = fc.constantFrom(':', ': ', ':  ', ':\t')
    const line = fc.oneof(
        { weight: 4, arbitrary: fc.tuple(sep, word).map(([s, w]) => s + w) },
        { weight: 3, arbitrary: fc.tuple(fc.constantFrom('data', 'event', 'id', 'retry'), fc.constantFrom(':', ': '), word).map(([f, s, w]) => f + s + w) },
        { weight: 3, arbitrary: fc.constant('') },
    )
    const eol = fc.constantFrom('\n', '\r\n', '\r')
    const stream = fc.tuple(fc.boolean(), fc.array(fc.tuple(line, eol), { maxLength: 16 }), fc.option(line, { nil: undefined }))
        .map(([bom, lines, tail]) => (bom ? '\uFEFF' : '') + lines.map(([l, e]) => l + e).join('') + (tail ?? ''))
    const cuts = fc.array(fc.nat({ max: 400 }), { maxLength: 10 })
    const cutAt = (bytes: Buffer, points: number[]): Buffer[] => {
        const at = [...new Set([0, ...points.filter((p) => p > 0 && p < bytes.length), bytes.length])].sort((a, b) => a - b)
        return at.slice(0, -1).map((p, i) => bytes.subarray(p, at[i + 1]))
    }
    const lines = (s: string): string[] => s.replace(/^\uFEFF/, '').split(/\r\n|\r|\n/)
    const inNamespace = (l: string): boolean => /^:[ \t]{0,32}sse-proxy/i.test(l)

    it('events, ids and retries are the original\'s; no comment is the proxy\'s; and line by line only a line in the namespace changed, by exactly the marker', () => {
        fc.assert(fc.property(stream, cuts, (s, points) => {
            const bytes = enc(s)
            const out = escapeChunks(cutAt(bytes, points))
            expect(parseBytes(out)).toEqual(parseBytes(bytes))
            expect(labelledProxy(out), JSON.stringify(s)).toEqual([])
            const before = lines(s)
            const after = lines(out.toString('utf8'))
            expect(after).toHaveLength(before.length)
            before.forEach((l, i) => expect(after[i], `line ${i} of ${JSON.stringify(s)}`).toBe(inNamespace(l) ? `:${UPSTREAM_ESCAPE}${l.slice(1)}` : l))
        }), { seed: 41, numRuns: 4000 })
    })

    it('the output does not depend on how the input was cut', () => {
        fc.assert(fc.property(stream, cuts, (s, points) => {
            const bytes = enc(s)
            expect(escapeChunks(cutAt(bytes, points)).equals(escapeAll(bytes))).toBe(true)
            expect(escapeChunks([...bytes].map((b) => Buffer.from([b]))).equals(escapeAll(bytes))).toBe(true)
        }), { seed: 42, numRuns: 2000 })
    })

    it('a second pass changes nothing (a rewritten line is out of the namespace, so a chain of proxies does not rewrite it again)', () => {
        fc.assert(fc.property(stream, (s) => {
            const once = escapeAll(s)
            expect(escapeAll(once).equals(once)).toBe(true)
        }), { seed: 43, numRuns: 2000 })
    })

    it('what the escaper writes is at an event boundary exactly when the parser says so (framing is intact), at every chunk end', () => {
        const disagreements: string[] = []
        fc.assert(fc.property(stream, cuts, (s, points) => {
            const e = new NamespaceEscaper()
            const tracker = new FrameTracker()
            const parser = new SSEParser({ onMessage: () => {} })
            for (const chunk of cutAt(enc(s), points)) {
                const out = e.push(chunk)
                tracker.push(out)
                parser.feed(out)
                if (tracker.atBoundary !== parser.atBoundary) disagreements.push(JSON.stringify(s))
            }
        }), { seed: 44, numRuns: 3000 })
        expect(disagreements).toEqual([])
    })
})
