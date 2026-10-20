// @vitest-environment node
import { describe, it, expect } from 'vitest'
import { toScenario, serializeScenario, headerEnvName } from '../toScenario'
import { parseScenarioText } from '../validate'
import { newHeader, type Capture, type CaptureHeader } from '../../capture/format'
import { markRedacted, type RedactedCapture } from '../../capture/redacted'
import { analyze, type Analysis } from '../../diagnostics'
import type { EngineInput } from '../../diagnostics/streamModel'
import type { Finding } from '../../diagnostics/finding'
import { capture as build, type CaptureBuilder } from '../../testing/captureBuilder'

const redacted = (b: CaptureBuilder, header: Partial<CaptureHeader> = {}): RedactedCapture =>
    markRedacted({ header: newHeader({ kind: 'sanitized', source: { kind: 'cli' }, ...header }), records: b.build() } satisfies Capture)

const run = (c: RedactedCapture, opts?: Parameters<typeof toScenario>[2]) => toScenario(c, analyze(c.records as EngineInput[]), opts)

const finding = (key: string, severity: Finding['severity']): Finding => ({
    key, ruleId: key.split(':')[0]!, ruleVersion: 1, severity, title: key, summary: '', facts: [], deductions: [], limits: [], status: 'open', firstSeenT: 0, lastSeenT: 0, occurrences: 1,
})
const withFindings = (c: RedactedCapture, findings: Finding[]): Analysis => ({ ...analyze(c.records as EngineInput[]), findings })

const healthy = (): CaptureBuilder => build().connect().response({ ttfbMs: 40 }).at(300).frame('message', '1').silence(100).frame('message', '2').silence(100).frame('message', '3')

describe('toScenario', () => {
    it('builds a simple scenario from a healthy capture', () => {
        const { scenario } = run(redacted(healthy()), { name: 'orders stream' })
        expect(scenario).toMatchObject({
            version: 1,
            name: 'orders stream',
            target: { url: '${ENV:STREAM_URL}' },
            expect: { status: 200, content_type: 'text/event-stream', first_event_within_ms: 1000 },
            steps: [{ collect_events: 3 }],
            verify: [{ no_findings_at_or_above: 'error' }],
            fail_on_severity: 'error',
        })
        expect(scenario.meta?.origin).toBe('http://stream.test')
    })

    it('sets the first-event allowance to 3x the observed time, at least 1000, in steps of 100', () => {
        const slow = build().connect().response().at(2345).frame().frame().frame().build()
        const c = markRedacted({ header: newHeader({ kind: 'sanitized', source: { kind: 'cli' } }), records: slow })
        // 2345 ms to the first event, times 3 = 7035, rounded to 7000.
        expect(run(c).scenario.expect?.first_event_within_ms).toBe(7000)
        const fast = redacted(build().connect().response().at(50).frame())
        expect(run(fast).scenario.expect?.first_event_within_ms).toBe(1000)
    })

    it('keeps the response media type without parameters, and says when the response was not healthy', () => {
        const c = redacted(build().connect().response({ status: 503, contentType: 'text/html; charset=utf-8' }).frame())
        const { scenario, notes } = run(c)
        expect(scenario.expect).toMatchObject({ status: 503, content_type: 'text/html' })
        expect(notes.join(' ')).toMatch(/response was 503/)
    })

    it('caps collect_events at 100 and uses at least 1', () => {
        const many = build().connect().response()
        for (let i = 0; i < 250; i++) many.silence(10).frame('message', String(i))
        expect(run(redacted(many)).scenario.steps[0]).toMatchObject({ collect_events: 100 })
        expect(run(redacted(many), { maxEvents: 40 }).scenario.steps[0]).toMatchObject({ collect_events: 40 })
        const none = redacted(build().connect().response().silence(500))
        const r = run(none)
        expect(r.scenario.steps).toEqual([{ collect_events: 1, timeout_ms: 10000 }])
        expect(r.scenario.expect?.first_event_within_ms).toBeUndefined()
        expect(r.notes.join(' ')).toMatch(/no events/)
    })

    it('derives header placeholders from names and never copies a value', () => {
        const header = {
            request: {
                url: 'https://api.example.com/v1/stream?token=SECRETQUERY',
                method: 'GET',
                headers: { Authorization: 'Bearer eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0In0.c2lnbmF0dXJlMTIzNA', 'X-Api-Key': ['sk', 'live', 'abcdefghijklmnopqrstuvwxyz0123456789'].join('_'), Cookie: 'sid=abc', Accept: 'text/event-stream', 'Last-Event-ID': '7' },
            },
        }
        const b = build().connect({ url: header.request.url }).response().at(300).frame('message', '1')
        const { scenario, notes } = run(redacted(b, header))
        expect(scenario.target.headers).toEqual({
            Authorization: '${ENV:STREAM_AUTHORIZATION}',
            'X-Api-Key': '${ENV:STREAM_X_API_KEY}',
            Cookie: '${ENV:STREAM_COOKIE}',
        })
        const text = serializeScenario(scenario)
        for (const leaked of ['eyJhbGci', 'sk_live', 'SECRETQUERY', 'sid=abc']) expect(text).not.toContain(leaked)
        expect(scenario.meta?.origin).toBe('https://api.example.com')
        expect(notes.join(' ')).toContain('STREAM_URL, STREAM_AUTHORIZATION, STREAM_X_API_KEY, STREAM_COOKIE')
        expect(headerEnvName('x-api.key')).toBe('STREAM_X_API_KEY')
    })

    it('leaves out the sequence check and says why when no contract is declared', () => {
        const { scenario, notes } = run(redacted(healthy()))
        expect(scenario.target.sequence).toBeUndefined()
        const note = notes.find((n) => /no sequence contract/.test(n))
        expect(note).toBeDefined()
        expect(scenario.meta?.notes).toContain(note)
    })

    it('emits the sequence contract the profile declares', () => {
        const profile = { sequence: { field: '$.seq', policy: 'monotonic' }, delivery: 'at_least_once' } as unknown as CaptureHeader['profile']
        const { scenario, notes } = run(redacted(healthy(), { profile }))
        expect(scenario.target.sequence).toEqual({ field: '$.seq', policy: 'monotonic' })
        expect(scenario.target.delivery).toBe('at_least_once')
        expect(notes.join(' ')).not.toMatch(/no sequence contract/)
        const viaId = { sequence: { useSseId: true } } as unknown as CaptureHeader['profile']
        expect(run(redacted(healthy(), { profile: viaId })).scenario.target.sequence).toEqual({ use_sse_id: true, policy: 'consecutive' })
        const nonsense = { sequence: { field: 'seq' } } as unknown as CaptureHeader['profile']
        expect(run(redacted(healthy(), { profile: nonsense })).scenario.target.sequence).toBeUndefined()
    })

    it('adds disconnect, reconnect and a second collect step for a capture that reconnected', () => {
        const b = build().connect().response().at(100).frame('message', '1').silence(50).frame('message', '2').silence(50).frame('message', '3')
            .reconnect({ delayMs: 1040, lastEventIdSent: '3', reason: 'Stream closed by server' })
            .silence(1040).connect({ sentLastEventId: '3' }).response().silence(20).frame('message', '4').frame('message', '5')
        const { scenario } = run(redacted(b))
        expect(scenario.steps.map((s) => Object.keys(s)[0])).toEqual(['collect_events', 'disconnect', 'reconnect', 'collect_events'])
        expect(scenario.steps[0]).toMatchObject({ collect_events: 3 })
        expect(scenario.steps[1]).toEqual({ disconnect: { mode: 'server' } })
        expect(scenario.steps[2]).toEqual({ reconnect: { after_ms: 1000, resume_from_last_event_id: true } })
        expect(scenario.steps[3]).toMatchObject({ collect_events: 2 })
    })

    it('does not ask to resume when no Last-Event-ID was sent, and treats other reasons as a client drop', () => {
        const b = build().connect().response().frame('message', '').reconnect({ delayMs: 500, lastEventIdSent: '', reason: 'Network error' }).connect().response().frame('message', '')
        const { scenario } = run(redacted(b))
        expect(scenario.steps[1]).toEqual({ disconnect: { mode: 'client' } })
        expect(scenario.steps[2]).toEqual({ reconnect: { after_ms: 500, resume_from_last_event_id: false } })
    })

    it('models at most three reconnects and says so', () => {
        const b = build().connect().response().frame('message', '1')
        for (let i = 0; i < 5; i++) b.reconnect({ attempt: i + 1, lastEventIdSent: String(i + 1) }).connect({ sentLastEventId: String(i + 1) }).response().frame('message', String(i + 2))
        const { scenario, notes } = run(redacted(b))
        expect(scenario.steps).toHaveLength(1 + 3 * 3)
        expect(notes.join(' ')).toMatch(/reconnected 5 times/)
    })

    describe('verify', () => {
        const c = redacted(healthy())
        it('adds the matching check for each gap, duplicate and order finding', () => {
            const a = withFindings(c, [finding('sequence.gap:conn0', 'error'), finding('sequence.duplicate', 'warning'), finding('sequence.order', 'warning')])
            expect(toScenario(c, a).scenario.verify).toEqual(['no_unexplained_sequence_gaps', 'no_unexpected_duplicates', 'preserve_event_order', { no_findings_at_or_above: 'error' }])
            const onlyDup = withFindings(c, [finding('sequence.duplicate', 'warning')])
            expect(toScenario(c, onlyDup).scenario.verify).toEqual(['no_unexpected_duplicates', { no_findings_at_or_above: 'error' }])
        })

        it('uses the lowest severity among error-or-worse findings, else error', () => {
            const mixed = withFindings(c, [finding('stall.silent:bytes', 'critical'), finding('proto.framing:x', 'error'), finding('heartbeat.late:origin', 'warning')])
            expect(toScenario(c, mixed).scenario).toMatchObject({ verify: [{ no_findings_at_or_above: 'error' }], fail_on_severity: 'error' })
            const critical = withFindings(c, [finding('stall.silent:bytes', 'critical')])
            expect(toScenario(c, critical).scenario.verify).toEqual([{ no_findings_at_or_above: 'critical' }])
            const warnings = withFindings(c, [finding('heartbeat.late:origin', 'warning')])
            expect(toScenario(c, warnings).scenario.verify).toEqual([{ no_findings_at_or_above: 'error' }])
        })

        it('ignores gap-like words in findings that are not about sequences', () => {
            const a = withFindings(c, [finding('stall.silent:gap', 'error')])
            expect(toScenario(c, a).scenario.verify).toEqual([{ no_findings_at_or_above: 'error' }])
        })
    })

    it('refuses to return a scenario that fails the secret scan', () => {
        const c = redacted(healthy())
        expect(() => toScenario(c, analyze(c.records as EngineInput[]), { name: 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dBjftJeZ4CVPmB92K27uhb' })).toThrow(/not valid.*JWT/)
    })

    it('round-trips through the file text and the parser', () => {
        const withHeader = { request: { url: 'https://a.test/e', method: 'GET', headers: { Authorization: 'x', 'X-Api-Key': 'y' } }, profile: { sequence: { field: '$.seq', policy: 'consecutive' } } } as unknown as Partial<CaptureHeader>
        const b = healthy().reconnect({ lastEventIdSent: '3' }).connect({ sentLastEventId: '3' }).response().frame('message', '4')
        const c = redacted(b, withHeader)
        const { scenario } = toScenario(c, withFindings(c, [finding('sequence.gap:conn0', 'error')]), { name: 'round trip' })
        const parsed = parseScenarioText(serializeScenario(scenario))
        expect(parsed.errors).toEqual([])
        expect(parsed.value).toEqual(scenario)
    })

    it('round-trips every other scenario this file builds', () => {
        for (const b of [healthy(), build().connect().response({ status: 500 }), build().connect().response().silence(100)]) {
            const { scenario } = run(redacted(b))
            expect(parseScenarioText(serializeScenario(scenario)).errors).toEqual([])
        }
    })
})
