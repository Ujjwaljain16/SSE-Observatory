import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { gzipSync } from 'node:zlib'
import { analyze } from '../../diagnostics/engine'
import type { Observation } from '../../observe/observation'
import { bytesToBase64 } from '../base64'
import { CaptureFormatError, captureEndT, newHeader, parseCapture, serializeCapture, type Capture, type CaptureRecord } from '../format'
import { connectionTexts } from '../streamText'
import { EXIT, main, type CliIo } from '../../../cli/index'

// Plan D2: odd files. A capture is the thing a person attaches to a bug report, so what reaches parseCapture is whatever survived a crash,
// an editor, a mail gateway or a wrong command: cut in the middle, empty, with a byte order mark, compressed. The reader must tell them
// apart, never throw anything but its own CaptureFormatError, and never let a damaged file look like a healthy stream.

/**
 * A real capture, 3 KB: the healthy fixture h01 as the lab ships it (public/lab is exempt from line-ending conversion, because the files carry
 * an integrity hash over their exact bytes). It is sanitized and pure ASCII, so a cut at any byte is a cut at any character.
 */
const REAL = readFileSync(new URL('../../../../public/lab/h01.sse-capture', import.meta.url), 'utf8')

const lineEnds = (text: string): number[] => [...text.matchAll(/\n/g)].map((m) => m.index! + 1)

function host(files: Record<string, string>) {
    let out = ''
    let err = ''
    const io: CliIo = { out: (t) => { out += t }, err: (t) => { err += t }, readText: async (p) => { if (p in files) return files[p]!; throw new Error('ENOENT') }, writeText: async () => undefined }
    return { io, get out() { return out }, get err() { return err } }
}

describe('the real capture used below', () => {
    it('is what the tests assume: 2-6 KB, ASCII, a header, records, a footer, and an intact integrity hash', () => {
        expect(REAL.length).toBeGreaterThan(2000)
        expect(REAL.length).toBeLessThan(6000)
        expect(/^[\x00-\x7f]*$/.test(REAL)).toBe(true)
        expect(REAL.endsWith('\n')).toBe(true)
        expect(REAL).not.toContain('\r')
        const parsed = parseCapture(REAL)
        expect(parsed.warnings).toEqual([])
        expect(parsed.integrity).toBe('ok')
        expect(parsed.capture.footer).toBeDefined()
        expect(parsed.capture.records.length).toBeGreaterThan(10)
    })
})

describe('a capture cut off at every byte', () => {
    const lines = REAL.split('\n').filter(Boolean)
    const footerStart = REAL.length - (lines.at(-1)!.length + 1) // where the last line, the footer, begins
    const full = parseCapture(REAL)

    it('is read as far as it goes, never throws anything but CaptureFormatError, and says what happened', () => {
        let readable = 0
        let refused = 0
        for (let cut = 0; cut <= REAL.length; cut++) {
            const prefix = REAL.slice(0, cut)
            let parsed: ReturnType<typeof parseCapture>
            try { parsed = parseCapture(prefix) } catch (error) {
                expect(error, `cut at byte ${cut}`).toBeInstanceOf(CaptureFormatError)
                // only a file that does not yet hold a whole header line can be refused
                expect(cut, `a cut at ${cut} refused a file that has a whole header`).toBeLessThan(REAL.indexOf('\n'))
                refused++
                continue
            }
            readable++
            const { records, footer } = parsed.capture
            // what was read is a prefix of the real records, in order, unchanged
            expect(records, `cut at byte ${cut}`).toEqual(full.capture.records.slice(0, records.length))
            const complete = cut >= REAL.length - 1 // the final newline is not part of the content
            if (complete) {
                expect(footer, `cut at ${cut}`).toBeDefined()
                expect(parsed.warnings, `cut at ${cut}`).toEqual([])
                expect(parsed.integrity).toBe('ok')
                continue
            }
            // an unfinished file always says so: it has no footer, and the integrity check is unavailable rather than passing
            expect(footer, `cut at ${cut}`).toBeUndefined()
            expect(parsed.integrity, `cut at ${cut}`).toBe('absent')
            expect(parsed.warnings.some((w) => /no footer|not finished/.test(w)), `cut at ${cut}: ${JSON.stringify(parsed.warnings)}`).toBe(true)
            // and a last line cut in the middle is named as cut off
            const lastLine = prefix.slice(prefix.lastIndexOf('\n') + 1)
            const midLine = lastLine.length > 0 && cut > REAL.indexOf('\n') + 1 && !isWholeJson(lastLine)
            if (midLine) expect(parsed.warnings.some((w) => /cut off/.test(w)), `cut at ${cut} (${JSON.stringify(lastLine.slice(0, 30))}...)`).toBe(true)
            else expect(parsed.warnings.some((w) => /cut off/.test(w)), `cut at ${cut} is on a line boundary`).toBe(false)
        }
        expect(refused).toBe(REAL.indexOf('\n')) // cuts 0 (empty) up to just before the header's own newline
        expect(readable).toBeGreaterThan(2500)
        expect(footerStart).toBeGreaterThan(REAL.indexOf('\n'))
    })

    it('analyses without throwing, and a cut capture reaches the user as a capture that was not finished (through the CLI, at every line end and in between)', async () => {
        const ends = lineEnds(REAL)
        const offsets = new Set<number>()
        for (const end of ends) { offsets.add(end); offsets.add(end - 1); offsets.add(end + 7) }
        for (let cut = 0; cut < REAL.length; cut += 61) offsets.add(cut)
        for (const cut of [...offsets].filter((c) => c >= 0 && c < REAL.length - 1).sort((a, b) => a - b)) {
            const prefix = REAL.slice(0, cut)
            const h = host({ 'cut.sse-capture': prefix })
            const code = await main(['analyze', 'cut.sse-capture'], h.io)
            if (cut < REAL.indexOf('\n')) {
                expect(code, `cut at ${cut}`).toBe(EXIT.usage)
                expect(h.err, `cut at ${cut}`).toMatch(/empty|not JSON|not an \.sse-capture/)
                expect(h.err).not.toMatch(/\bat\s+\S+\s+\(/) // no stack frame
            } else {
                expect([EXIT.ok, EXIT.gateFailed], `cut at ${cut}`).toContain(code)
                expect(h.out, `cut at ${cut}: a cut capture must not read as a clean one`).toMatch(/no footer/)
            }
        }
    })
})

const isWholeJson = (line: string): boolean => { try { JSON.parse(line); return true } catch { return false } }

describe('files that are not captures', () => {
    it('an empty file, and one that holds only whitespace, are refused as empty', () => {
        for (const text of ['', '\n', '\r\n\r\n', '   \n\t\n', '﻿', '﻿\r\n']) expect(() => parseCapture(text), JSON.stringify(text)).toThrow(/the file is empty/)
    })

    it('gzip bytes (a captured file somebody compressed) are refused as not an sse-capture, with exit 2 and no stack', async () => {
        const gz = gzipSync(Buffer.from(REAL))
        const asText = gz.toString('utf8') // what a reader that opens the file as UTF-8 text gets
        expect(() => parseCapture(asText)).toThrow(CaptureFormatError)
        expect(() => parseCapture(asText)).toThrow(/not JSON; this is not an \.sse-capture file/)
        const h = host({ 'x.sse-capture.gz': asText })
        expect(await main(['analyze', 'x.sse-capture.gz'], h.io)).toBe(EXIT.usage)
        expect(h.err).toContain('this is not an .sse-capture file')
        expect(h.err).not.toMatch(/\bat\s+\S+\s+\(/)
        // the same through the other commands that read a capture
        for (const command of ['report', 'redact', 'compare']) {
            const g = host({ 'x.gz': asText, 'y.gz': asText })
            expect(await main(command === 'compare' ? [command, 'x.gz', 'y.gz'] : [command, 'x.gz'], g.io), command).toBe(EXIT.usage)
        }
    })

    it('text that is JSON but not a capture, and a capture header of a newer major version, are refused with a reason', () => {
        expect(() => parseCapture('[1,2,3]')).toThrow(/not an sse-capture header/)
        expect(() => parseCapture('{"format":"other"}')).toThrow(/not an sse-capture header/)
        expect(() => parseCapture(REAL.replace('"version":"2.0"', '"version":"3.0"'))).toThrow(/unsupported capture version "3\.0"/)
        expect(() => parseCapture(REAL.replace('"version":"2.0"', '"version":"2"')).capture).not.toThrow() // a bare major is the same major
    })
})

describe('line endings and the byte order mark', () => {
    it('a BOM, CRLF, and both, read exactly as the file without them (records, footer, and a matching hash)', () => {
        const base = parseCapture(REAL)
        for (const variant of ['﻿' + REAL, REAL.replace(/\n/g, '\r\n'), '﻿' + REAL.replace(/\n/g, '\r\n')]) {
            const parsed = parseCapture(variant)
            expect(parsed.capture).toEqual(base.capture)
            expect(parsed.integrity).toBe('ok')
            expect(parsed.warnings).toEqual([])
        }
    })

    it('through the CLI: a file saved by a PowerShell redirect (BOM and CRLF) analyses as the original does, with nothing to warn about', async () => {
        const original = host({ 'a.sse-capture': REAL })
        const saved = host({ 'a.sse-capture': '﻿' + REAL.replace(/\n/g, '\r\n') })
        expect(await main(['analyze', 'a.sse-capture', '--format', 'json'], original.io)).toBe(await main(['analyze', 'a.sse-capture', '--format', 'json'], saved.io))
        expect(JSON.parse(saved.out)).toEqual(JSON.parse(original.out))
        expect(saved.err).toBe('')
    })

    it('a lone CR in a record line is part of the JSON string, not a line ending, and the file still reads', () => {
        // JSON cannot hold a raw CR inside a string, so a record with an escaped one stays one line
        const capture: Capture = { header: newHeader({ kind: 'sanitized', source: { kind: 'fixture' } }), records: [{ seq: 0, t: 0, conn: 0, kind: 'comment', text: 'a\rb\r\nc', source: 'upstream' } as CaptureRecord] }
        const parsed = parseCapture(serializeCapture(capture))
        expect((parsed.capture.records[0] as { text: string }).text).toBe('a\rb\r\nc')
        expect(parsed.integrity).toBe('ok')
    })
})

describe('a record of 1 MiB', () => {
    it('is written, read back, decoded, analysed and re-written byte for byte', () => {
        const bytes = new Uint8Array(1024 * 1024)
        for (let i = 0; i < bytes.length; i++) bytes[i] = 0x61 + (i % 26) // letters: valid UTF-8, no newline, so the "stream text" is one long line
        const b64 = bytesToBase64(bytes)
        expect(b64.length).toBeGreaterThan(1_398_000) // the line really is about 1.4 MB
        const capture: Capture = {
            header: newHeader({ kind: 'local-full', source: { kind: 'fixture' } }),
            records: [
                { seq: 0, t: 0, conn: 0, kind: 'connect', attempt: 0, url: 'http://x.test/', method: 'GET', headerNames: [], sentLastEventId: '' },
                { seq: 1, t: 1, conn: 0, kind: 'chunk', bytes: bytes.length, b64 },
                { seq: 2, t: 2, conn: 0, kind: 'chunk', bytes: 5, b64: bytesToBase64(new TextEncoder().encode('\n\n')) },
            ] as CaptureRecord[],
        }
        const text = serializeCapture(capture)
        const parsed = parseCapture(text)
        expect(parsed.warnings).toEqual([])
        expect(parsed.integrity).toBe('ok')
        expect((parsed.capture.records[1] as { b64: string }).b64).toBe(b64)
        expect(connectionTexts(parsed.capture.records).get(0)!.length).toBe(bytes.length + 2)
        expect(() => analyze(parsed.capture.records as Observation[])).not.toThrow()
        expect(serializeCapture(parsed.capture)).toBe(text)
    })

    it('cut in the middle of that record, it is a cut-off line like any other, not an exception', () => {
        const big = serializeCapture({ header: newHeader({ kind: 'local-full', source: { kind: 'fixture' } }), records: [{ seq: 0, t: 0, conn: 0, kind: 'chunk', bytes: 1048576, b64: 'QUJD'.repeat(349_525) } as CaptureRecord] })
        const parsed = parseCapture(big.slice(0, Math.floor(big.length / 2)))
        expect(parsed.capture.records).toEqual([])
        expect(parsed.warnings.some((w) => /cut off/.test(w))).toBe(true)
    })
})

describe('records that break the format\'s own promises', () => {
    const header = () => newHeader({ kind: 'sanitized', source: { kind: 'fixture' } })
    const rec = (seq: number, t: number, extra: Record<string, unknown> = {}): CaptureRecord => ({ seq, t, conn: 0, kind: 'comment', text: `c${seq}`, source: 'upstream', ...extra }) as CaptureRecord
    const file = (records: CaptureRecord[]) => serializeCapture({ header: header(), records })

    // Owner decision (these two pinned "accepted, no warning" before): a duplicate seq or a backwards t is NOT healthy. The file is still read as far
    // as it goes, so the damage can be shown, but it carries `problems` and the command line and the Doctor refuse it (see integrity.test.ts and
    // integrityCli.test.ts).
    it('a duplicate seq is read as it is (both records, in file order, the hash fine) and is reported as a problem, at its line', () => {
        const parsed = parseCapture(file([rec(0, 0), rec(1, 5), rec(1, 9), rec(2, 12)]))
        expect(parsed.capture.records.map((r) => [r.seq, r.t])).toEqual([[0, 0], [1, 5], [1, 9], [2, 12]])
        expect(parsed.integrity).toBe('ok')
        expect(parsed.problems.map((p) => [p.code, p.seq, p.line])).toEqual([['seq.duplicate', 1, 4]])
        expect(() => analyze(parsed.capture.records as Observation[])).not.toThrow()
    })

    it('a time that goes backwards is read as it is, the capture ends at its LATEST time, and the file is reported as invalid at the record that went back', () => {
        const parsed = parseCapture(file([rec(0, 100), rec(1, 40), rec(2, 70)]))
        expect(parsed.capture.records.map((r) => r.t)).toEqual([100, 40, 70])
        expect(captureEndT(parsed.capture)).toBe(100)
        expect(parsed.warnings).toEqual([])
        expect(parsed.problems.map((p) => [p.code, p.seq, p.line])).toEqual([['t.backwards', 1, 3]])
    })

    it('analysis of out-of-order times does not throw and puts no NaN or Infinity in any finding', () => {
        const stream = (ts: number[]): CaptureRecord[] => [
            { seq: 0, t: ts[0]!, conn: 0, kind: 'connect', attempt: 0, url: 'http://x.test/', method: 'GET', headerNames: [], sentLastEventId: '' },
            { seq: 1, t: ts[1]!, conn: 0, kind: 'response', status: 200, contentType: 'text/event-stream', redirected: false, headers: {}, ttfbMs: 1 },
            ...ts.slice(2).map((t, i) => ({ seq: 2 + i, t, conn: 0, kind: 'event', event: 'tick', sseId: String(i + 1), dataBytes: 3 })),
        ] as CaptureRecord[]
        for (const ts of [[0, 5, 1000, 500, 2000, 1500], [9000, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16], [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 0], [0, 1, 1e9, 2, 3]]) {
            const result = analyze(stream(ts) as Observation[], { endT: Math.max(...ts) })
            expect(JSON.stringify(result.findings), JSON.stringify(ts)).not.toMatch(/NaN|Infinity|-\d+(?:\.\d+)? ?(?:ms|s)\b/)
        }
    })

    it('a header and nothing else is an empty capture that says it was not finished, and analysing it does not call the stream healthy', async () => {
        const headerOnly = serializeCapture({ header: header(), records: [] }).split('\n')[0]! + '\n'
        const parsed = parseCapture(headerOnly)
        expect(parsed.capture.records).toEqual([])
        expect(parsed.warnings.some((w) => /no footer/.test(w))).toBe(true)
        const result = analyze(parsed.capture.records as Observation[])
        expect(result.findings).toEqual([])
        // with no records no rule has anything to look at, except the clock check, which needs no particular record kind
        expect(result.coverage.filter((c) => c.status === 'evaluated').map((c) => c.ruleId)).toEqual(['clock.discontinuity'])
        const h = host({ 'h.sse-capture': headerOnly })
        expect([EXIT.ok, EXIT.gateFailed]).toContain(await main(['analyze', 'h.sse-capture'], h.io))
        expect(h.out).toMatch(/no footer/)
        expect(h.out).toMatch(/Not evaluated \(this is not the same as healthy\)/)
    })

    it('with a footer but no records, the file is complete and empty', () => {
        const parsed = parseCapture(serializeCapture({ header: header(), records: [] }))
        expect(parsed.warnings).toEqual([])
        expect(parsed.capture.records).toEqual([])
        expect(parsed.capture.footer?.counts).toEqual({})
    })

    it('record kinds this reader does not know are kept, in their place, through a write and a read, and do not change the analysis', () => {
        const known = parseCapture(REAL).capture
        const withUnknown: CaptureRecord[] = []
        known.records.forEach((r, i) => {
            withUnknown.push(r)
            // a record of a kind a newer writer adds comes from the same counter and the same clock, so it sits between its neighbours (seq r.seq + 0.5): a
            // capture whose seq repeats or goes down is invalid now, and this test is about unknown KINDS, not about a file that breaks the order
            if (i % 4 === 1) withUnknown.push({ seq: r.seq + 0.5, t: r.t, conn: r.conn, kind: i % 8 === 1 ? 'future.metric' : 'x', payload: { n: i, nested: [1, { deep: true }] } })
        })
        const text = serializeCapture({ header: known.header, records: withUnknown })
        const parsed = parseCapture(text)
        expect(parsed.warnings).toEqual([])
        expect(parsed.problems).toEqual([])
        expect(parsed.integrity).toBe('ok')
        expect(parsed.capture.records).toEqual(withUnknown) // same records, same order, unknown fields intact
        expect(parsed.capture.footer?.counts['future.metric']).toBeGreaterThan(0)
        expect(serializeCapture(parsed.capture)).toBe(text) // and written back unchanged
        const a = analyze(parsed.capture.records as Observation[], { endT: captureEndT(known) })
        const b = analyze(known.records as Observation[], { endT: captureEndT(known) })
        expect(a.findings).toEqual(b.findings)
    })

    it('header fields it does not know, and a newer minor version, are kept and noted', () => {
        const newer = REAL.replace('"version":"2.0"', '"version":"2.7","futureThing":{"a":1}')
        const parsed = parseCapture(newer)
        expect(parsed.warnings.some((w) => /version 2\.7/.test(w))).toBe(true)
        expect((parsed.capture.header as unknown as Record<string, unknown>)['futureThing']).toEqual({ a: 1 })
    })
})

describe('a damaged line in the middle is not a cut-off end', () => {
    it('a middle line that is not JSON is refused with its line number (only the LAST line may be cut off)', () => {
        const lines = REAL.split('\n')
        lines[5] = lines[5]!.slice(0, 40)
        expect(() => parseCapture(lines.join('\n'))).toThrow(/line 6: not valid JSON/)
    })

    it('a record without kind, seq or t is refused with its line number, as is a line that is JSON but not an object', () => {
        const lines = REAL.split('\n')
        expect(() => parseCapture([...lines.slice(0, 3), '{"seq":1,"t":2}', ...lines.slice(3)].join('\n'))).toThrow(/line 4: a record needs "kind", "seq" and "t"/)
        expect(() => parseCapture([...lines.slice(0, 3), '[1]', ...lines.slice(3)].join('\n'))).toThrow(/line 4: a record must be a JSON object/)
    })
})
