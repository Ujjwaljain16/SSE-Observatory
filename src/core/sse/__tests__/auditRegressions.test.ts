// @vitest-environment node
import { describe, it, expect } from 'vitest'
import { SSEParser, SSEParserError } from '../sseParser'
import { SSEClient } from '../sseClient'
import type { Observation } from '../../observe/observation'
import { Recorder } from '../../observe/recorder'
import { analyze } from '../../diagnostics/engine'
import http from 'node:http'
import type { AddressInfo } from 'node:net'

const collect = (bytes: Uint8Array[]) => {
    const violations: string[] = []
    const events: string[] = []
    const parser = new SSEParser({ onMessage: (m) => events.push(m.data), onViolation: (v) => violations.push(v.code) })
    for (const b of bytes) parser.feed(b)
    return { violations, events }
}

describe('byte order mark', () => {
    it('is noticed when it arrives as bytes (the decoder strips it silently), once, at the start only', () => {
        const bytes = new TextEncoder().encode('﻿data: a\n\n')
        const r = collect([bytes])
        expect(r.events).toEqual(['a'])
        expect(r.violations).toEqual(['BOM_STRIPPED'])
        // a BOM split across the first two reads is still stripped by the decoder; no false claim is made about it
        expect(collect([bytes.slice(0, 2), bytes.slice(2)]).events).toEqual(['a'])
        expect(collect([new TextEncoder().encode('data: a\n\n')]).violations).toEqual([])
    })

    it('is still noticed when the stream is fed as a string', () => {
        const violations: string[] = []
        const parser = new SSEParser({ onMessage: () => undefined, onViolation: (v) => violations.push(v.code) })
        parser.feed('﻿data: a\n\n')
        expect(violations).toEqual(['BOM_STRIPPED'])
    })
})

describe('very long lines', () => {
    it('are scanned once, not again for every piece: a 15 MB line in 32 KB reads takes well under a second', () => {
        const parser = new SSEParser({ onMessage: () => undefined })
        const piece = new TextEncoder().encode('x'.repeat(32 * 1024))
        const started = performance.now()
        parser.feed(new TextEncoder().encode('data: '))
        for (let i = 0; i < 480; i++) parser.feed(piece) // about 15 MB, under the 16 MiB limit
        parser.feed(new TextEncoder().encode('\n\n'))
        expect(performance.now() - started).toBeLessThan(2000)
    })

    it('past the limit the stream is abandoned with a violation', () => {
        const violations: string[] = []
        const parser = new SSEParser({ onMessage: () => undefined, onViolation: (v) => violations.push(v.code) }, 1024 * 1024)
        const piece = new TextEncoder().encode('y'.repeat(64 * 1024))
        expect(() => { for (let i = 0; i < 40; i++) parser.feed(piece) }).toThrow(SSEParserError)
        expect(violations).toContain('LINE_TOO_LONG')
    })

    it('a CRLF split between two reads is still read as one line ending when the buffer holds a long line', () => {
        const events: string[] = []
        const parser = new SSEParser({ onMessage: (m) => events.push(m.data) })
        const long = 'z'.repeat(100_000)
        parser.feed(new TextEncoder().encode(`data: ${long}\r`))
        parser.feed(new TextEncoder().encode('\n\r\n'))
        expect(events).toEqual([long])
    })
})

describe('HTTP 204', () => {
    it('is reported as a status finding, so a probe of a 204 endpoint is not "no findings"', async () => {
        const server = http.createServer((_req, res) => { res.writeHead(204); res.end() })
        await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
        const records: Observation[] = []
        const recorder = new Recorder({ onRecord: (o) => records.push(o) })
        let done!: () => void
        const ended = new Promise<void>((r) => { done = r })
        const client = new SSEClient({ request: () => ({ url: `http://127.0.0.1:${(server.address() as AddressInfo).port}/` }), onMessage: () => undefined, onPhase: (p) => { if (p === 'ended') done() }, onObservation: (d) => recorder.record(d) })
        client.start()
        await ended
        client.stop()
        server.close()
        const findings = analyze(records, { endT: recorder.elapsed() }).findings
        const status = findings.find((f) => f.key === 'http.status')!
        expect(status.summary).toContain('204')
        expect(status.deductions[0]!.statement).toMatch(/^Likely: the server has nothing to stream/)
    })
})
