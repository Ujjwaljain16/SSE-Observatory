import { afterEach, describe, expect, it } from 'vitest'
import { ARTIFACTS, prepare, type ArtifactKind } from '../artifacts'
import { captureOf } from '../captureOf'
import { observationRegistry } from '../observationRegistry'
import { captureEndT, parseCapture } from '../../core/capture/format'
import { localCapture } from '../../core/capture/build'
import { analyze } from '../../core/diagnostics/engine'
import { validateScenario } from '../../core/scenario/validate'
import { capture as build, healthyStart } from '../../core/testing/captureBuilder'
import type { CaptureRecord } from '../../core/capture/format'
import type { EngineInput } from '../../core/diagnostics/streamModel'

// Secrets built at run time so this file holds none (and push protection has nothing to match).
const JWT = ['eyJhbGciOiJIUzI1NiJ9', 'eyJzdWIiOiIxMjM0NTY3ODkwIn0', 'c2lnbmF0dXJlLXZhbHVlLW5vdC1yZWFs'].join('.')
const BEARER = 'Bearer ' + ['abcd', 'EFGH', '1234', 'ijkl', '5678', 'MNOP'].join('')

function leaky() {
    const b = healthyStart()
    b.frame('tick', '1').comment(`debug auth ${JWT}`).frame('tick', '2')
    const records = b.observations() as CaptureRecord[]
    return localCapture(records, {
        source: { kind: 'browser-app', client: 'browser-fetch' },
        request: { url: 'https://stream.test/events?room=7', headers: { authorization: BEARER, accept: 'text/event-stream' } },
        captureId: 'abcdef12-0000',
    })
}

const SHARED: ArtifactKind[] = ['report-md', 'report-html', 'report-json', 'capture-shared', 'curl', 'scenario']

describe('what the Doctor can export', () => {
    it('lists every choice once, and only the local capture is not shareable', () => {
        expect(new Set(ARTIFACTS.map((a) => a.kind)).size).toBe(ARTIFACTS.length)
        expect(ARTIFACTS.filter((a) => !a.shareable).map((a) => a.kind)).toEqual(['capture-local'])
    })

    it.each(SHARED)('%s holds none of the secrets the recording had', (kind) => {
        const out = prepare(kind, leaky())
        expect(out.text).not.toContain(JWT)
        expect(out.text).not.toContain('abcdEFGH1234ijkl5678MNOP')
        expect(out.shareable).toBe(true)
        expect(out.redaction?.placeholders).toBeGreaterThan(0)
    })

    it('the local capture is the recording as it is, and says it is not to be shared', () => {
        const out = prepare('capture-local', leaky())
        expect(out.text).toContain(JWT)
        expect(out.shareable).toBe(false)
        expect(out.filename).toMatch(/\.local\.sse-capture$/)
        const parsed = parseCapture(out.text)
        expect(parsed.capture.header.kind).toBe('local-full')
        expect(parsed.integrity).toBe('ok')
    })

    it('a shareable capture reads back as sanitized with a valid hash', () => {
        const parsed = parseCapture(prepare('capture-shared', leaky()).text)
        expect(parsed.capture.header.kind).toBe('sanitized')
        expect(parsed.integrity).toBe('ok')
        expect(parsed.capture.header.redaction?.placeholders).toBeGreaterThan(0)
    })

    it('the test scenario is valid and takes its secrets from the environment', () => {
        const out = prepare('scenario', leaky())
        const scenario = JSON.parse(out.text) as unknown
        expect(validateScenario(scenario)).toEqual([])
        expect(out.text).toContain('${ENV:STREAM_URL}')
    })

    it('the curl command comes in both shells', () => {
        expect(prepare('curl', leaky(), { shell: 'powershell' }).text).toContain('curl.exe')
        expect(prepare('curl', leaky()).text).toMatch(/^curl -N/)
    })

    it('says when something that still looks secret is left, without printing it', () => {
        // a long random-looking token in a comment matches no named secret format, so redaction keeps it and the scan flags it
        const token = 'q7Zr4KpX9vLm2NcB8wTy5HsJ3dFg6A1e'
        const b = healthyStart()
        b.frame('tick', '1').comment(`session ${token}`)
        const c = localCapture(b.observations() as CaptureRecord[], { source: { kind: 'browser-app' }, request: { url: 'https://stream.test/e' } })
        const out = prepare('report-md', c)
        expect(out.residual.length).toBeGreaterThan(0)
        expect(JSON.stringify(out.residual)).not.toContain(token)
    })

    it('a capture with nothing secret has a clean scan', () => {
        const c = localCapture(healthyStart().frame('tick', '1').observations() as CaptureRecord[], { source: { kind: 'browser-app' }, request: { url: 'https://stream.test/e' } })
        expect(prepare('capture-shared', c).residual).toEqual([])
    })

    it('the smallest capture keeps the chosen finding and drops records', () => {
        const b = build().connect().response({ contentType: 'text/plain' })
        for (let i = 0; i < 30; i++) b.frame('tick', String(i))
        const c = localCapture(b.observations() as CaptureRecord[], { source: { kind: 'browser-app' }, request: { url: 'https://stream.test/e' } })
        const key = analyze(c.records as EngineInput[], { endT: b.now }).findings.find((f) => f.severity === 'error')!.key
        const out = prepare('repro', c, { findingKey: key })
        const small = parseCapture(out.text).capture
        expect(small.records.length).toBeLessThan(c.records.length)
        expect(analyze(small.records as EngineInput[], {}).findings.some((f) => f.key === key)).toBe(true)
        expect(out.notes.join(' ')).toMatch(/Reduced from/)
    })

    it('a silence after the last record counts when the capture says when it ended', () => {
        const b = healthyStart()
        for (let i = 0; i < 14; i++) b.silence(250).frame('tick', String(i))
        const records = b.observations() as CaptureRecord[]
        const init = { source: { kind: 'browser-app' as const }, request: { url: 'https://stream.test/e' } }
        const stalled = (c: ReturnType<typeof localCapture>) => analyze(c.records as EngineInput[], { endT: captureEndT(c) }).findings.some((f) => f.ruleId.startsWith('stall'))
        const open = localCapture(records, init)
        expect(stalled(open)).toBe(false) // as far as the records go the stream was fine
        const later = localCapture(records, init)
        later.footer = { endReason: 'stopped', counts: {}, endT: b.now + 60_000 }
        expect(stalled(later)).toBe(true) // a minute of silence followed
        const key = analyze(later.records as EngineInput[], { endT: captureEndT(later) }).findings.find((f) => f.ruleId.startsWith('stall'))!.key
        const out = prepare('repro', later, { findingKey: key })
        expect(out.notes.join(' ')).toMatch(/Reduced from/)
        const small = parseCapture(out.text).capture
        expect(small.footer?.endT).toBe(b.now + 60_000)
        expect(small.records.length).toBeLessThan(later.records.length)
        expect(prepare('report-md', later).text).toMatch(/silent|silence/i)
    })

    it('the smallest capture needs to know which finding', () => {
        expect(() => prepare('repro', leaky())).toThrow(/Choose which finding/)
    })
})

describe('the recording as a capture', () => {
    afterEach(() => observationRegistry.close('snap'))

    it('is undefined while nothing was recorded', () => {
        expect(captureOf('snap')).toBeUndefined()
    })

    it('becomes a local-full capture of what the stream recorded, without page-domain samples', () => {
        const b = healthyStart().frame('tick', '1').frame('tick', '2')
        observationRegistry.receive('snap', { captureId: 'cap-snap-1', batch: b.observations() })
        observationRegistry.recordConsumer('snap', { kind: 'consumer', n: 1, queueDepth: 0, receivedT: 1, processedT: 2, lagMs: 1 })
        const snap = captureOf('snap')!
        expect(snap.capture.header.kind).toBe('local-full')
        expect(snap.capture.header.captureId).toBe('cap-snap-1')
        expect(snap.capture.header.request?.url).toBe('http://stream.test/events')
        expect(snap.capture.records.length).toBe(b.observations().length)
        expect(snap.capture.records.some((r) => r.kind === 'consumer')).toBe(false)
        expect(snap.truncated).toBe(false)
        expect(captureOf('snap', 9000)!.capture.footer?.endT).toBe(9000)
        expect(parseCapture(prepare('capture-local', snap.capture).text).integrity).toBe('ok')
    })
})
