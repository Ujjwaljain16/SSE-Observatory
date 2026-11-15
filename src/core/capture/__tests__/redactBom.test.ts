// @vitest-environment node
import { describe, expect, it } from 'vitest'
import { bytesToBase64 } from '../base64'
import { newHeader, type Capture } from '../format'
import { redactCapture } from '../redact'
import { connectionTexts } from '../streamText'

// Found by putting f15-malformed (plan A3) through the capture -> sanitized export -> replay round trip: the replay of the sanitized capture did
// not report BOM_STRIPPED, the one finding that stream's original run had and its replay lacked. The redactor decoded the wire bytes with a
// default TextDecoder, which drops a byte order mark at the start of the stream, so the sanitized capture held text that had never had one.
// A sanitized capture is meant to be the same stream with the secrets taken out; a different first three bytes is not that.

const BOM = [0xef, 0xbb, 0xbf]
const capture = (parts: number[][]): Capture => ({
    header: newHeader({ kind: 'local-full', source: { kind: 'fixture' } }),
    records: parts.map((bytes, i) => ({ seq: i, t: i * 10, conn: 0, kind: 'chunk' as const, bytes: bytes.length, b64: bytesToBase64(Uint8Array.from(bytes)) })),
})
const text = (s: string): number[] => [...new TextEncoder().encode(s)]
const sanitizedText = (c: Capture): string => [...connectionTexts(redactCapture(c).capture.records).values()].join('')

describe('redaction keeps the stream it is given, byte order mark included', () => {
    it('a stream that starts with a byte order mark still does in the sanitized capture', () => {
        expect(sanitizedText(capture([[...BOM, ...text('id: 1\ndata: x\n\n')]]))).toBe('﻿id: 1\ndata: x\n\n')
    })

    it('however the first bytes are cut: the mark split across two chunks, or alone in the first one', () => {
        expect(sanitizedText(capture([BOM.slice(0, 1), [...BOM.slice(1), ...text('data: x\n\n')]]))).toBe('﻿data: x\n\n')
        expect(sanitizedText(capture([BOM, text('data: x\n\n')]))).toBe('﻿data: x\n\n')
    })

    it('a stream without one is unchanged (and a mark that is not at the start is a character like any other)', () => {
        expect(sanitizedText(capture([text('data: x\n\n')]))).toBe('data: x\n\n')
        expect(sanitizedText(capture([text('data: x\n\n'), [...BOM, ...text('data: y\n\n')]]))).toBe('data: x\n\n﻿data: y\n\n')
    })

    it('a secret behind the mark is still redacted', () => {
        const out = sanitizedText(capture([[...BOM, ...text('id: 1\ndata: {"password":"hunter2-canary"}\n\n')]]))
        expect(out.startsWith('﻿id: 1\n')).toBe(true)
        expect(out).not.toContain('hunter2-canary')
    })
})
