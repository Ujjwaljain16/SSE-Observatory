// @vitest-environment node
import { describe, it, expect } from 'vitest'
import { toScenario, serializeScenario, headerEnvName, stallLimitMs } from '../toScenario'
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

    // Q4b: a scenario is a regression check, so a bad captured response is never expected again; the healthy one is.
    it('expects HTTP 200 and text/event-stream when the captured response was not healthy, and says it verifies the fix', () => {
        for (const bad of [{ status: 503, contentType: 'text/html; charset=utf-8' }, { status: 200, contentType: 'text/html' }, { status: 200, contentType: '' }, { status: 401, contentType: 'text/event-stream' }, { status: 404, contentType: 'application/json' }]) {
            const { scenario, notes } = run(redacted(build().connect().response(bad).frame()))
            expect(scenario.expect, JSON.stringify(bad)).toMatchObject({ status: 200, content_type: 'text/event-stream' })
            const note = notes.find((n) => /not a healthy event stream/.test(n))
            expect(note, JSON.stringify(bad)).toBeDefined()
            expect(note).toContain(`was ${bad.status} `)
            expect(note).toMatch(/designed to verify the fix, not to reproduce the broken response/)
            expect(note).toMatch(/expects HTTP 200 and text\/event-stream/)
            expect(scenario.meta?.notes).toContain(note)
        }
    })

    it('says nothing about the response when it was a healthy event stream (parameters do not matter)', () => {
        for (const contentType of ['text/event-stream', 'text/event-stream; charset=utf-8', 'TEXT/Event-Stream']) {
            const { scenario, notes } = run(redacted(build().connect().response({ status: 200, contentType }).frame()))
            expect(scenario.expect).toMatchObject({ status: 200, content_type: 'text/event-stream' })
            expect(notes.join(' ')).not.toMatch(/healthy event stream|verify the fix/)
        }
    })

    // Q4a: a stall in the capture becomes expect.max_silence_ms, from the stall rule's own limit.
    const steadyThenSilent = (everyMs: number, silenceMs: number, events = 12): CaptureBuilder => {
        const b = build().connect().response({ ttfbMs: 20 })
        for (let i = 0; i < events; i++) b.silence(everyMs).frame('message', String(i + 1))
        return b.silence(silenceMs)
    }
    const stalled = (b: CaptureBuilder) => { const c = redacted(b); return { c, analysis: analyze(c.records as EngineInput[], { endT: b.now }) } }

    it('sets expect.max_silence_ms from the limit of the capture\'s stall finding, and says what it did', () => {
        // a limit is three times the 95th percentile of the stream's own gaps, at least a second: 250 ms events -> 1 s, 1 s events -> 3 s, 1.111 s events -> 3.333 s
        for (const [every, expected] of [[250, 1000], [1000, 3000], [1111, 3333.3]] as const) {
            const { c, analysis } = stalled(steadyThenSilent(every, 60_000))
            const finding = analysis.findings.find((f) => f.key.startsWith('stall.silent'))
            expect(finding, `a ${every} ms stream that went silent has a stall finding`).toBeDefined()
            const exact = finding!.firstSeenT - finding!.facts[0]!.evidence[0]!.t // when the stall rule crossed its limit, counted from the last byte
            expect(exact).toBeCloseTo(expected, 0)
            const { scenario, notes } = toScenario(c, analysis)
            const value = scenario.expect?.max_silence_ms
            expect(value, `${every} ms`).toBeGreaterThanOrEqual(Math.ceil(exact)) // never stricter than the rule it came from
            expect(value, `${every} ms`).toBeLessThanOrEqual(exact + 50) // and not looser than the text it is read from can say
            const note = notes.find((n) => /max_silence_ms/.test(n))
            expect(note).toBeDefined()
            expect(note).toContain(`stall.silent:bytes`)
            expect(note).toContain(String(value))
            expect(scenario.meta?.notes).toContain(note)
            expect(parseScenarioText(serializeScenario(scenario)).errors).toEqual([])
        }
    })

    it('leaves max_silence_ms out when the capture has no stall finding', () => {
        const { scenario, notes } = run(redacted(healthy()))
        expect(scenario.expect?.max_silence_ms).toBeUndefined()
        expect(notes.join(' ')).not.toMatch(/max_silence_ms|stall/)
        const quiet = stalled(steadyThenSilent(250, 300)) // a pause below the limit is not a stall
        expect(quiet.analysis.findings.some((f) => f.key.startsWith('stall.silent'))).toBe(false)
        expect(toScenario(quiet.c, quiet.analysis).scenario.expect?.max_silence_ms).toBeUndefined()
        // a finding of another rule does not count
        const c = redacted(healthy())
        expect(toScenario(c, withFindings(c, [finding('delivery.bursty', 'warning')])).scenario.expect?.max_silence_ms).toBeUndefined()
    })

    it('takes the shortest limit when the capture has several stall findings, and says so when a limit cannot be read', () => {
        const c = redacted(healthy())
        const stall = (key: string, text: string): Finding => ({ ...finding(key, 'error'), facts: [{ text: 'No data.', evidence: [] }, { text, evidence: [] }] })
        const many = withFindings(c, [stall('stall.silent:events', 'The threshold was 20 s (50 s for an error), set from this stream\'s own rhythm.'), stall('stall.silent:bytes', 'The threshold was 3.0 s (5 s for an error), set from this stream\'s own rhythm.')])
        expect(toScenario(c, many).scenario.expect?.max_silence_ms).toBe(3050)
        const unreadable = toScenario(c, withFindings(c, [finding('stall.silent:bytes', 'error')]))
        expect(unreadable.scenario.expect?.max_silence_ms).toBeUndefined()
        expect(unreadable.notes.join(' ')).toMatch(/limit could not be read.*does not check for the stall/)
    })

    it('reads the limit from the stall rule\'s own wording (the text this depends on is the rule\'s, so a change there fails here)', () => {
        const fact = (text: string): Finding => ({ ...finding('stall.silent:bytes', 'error'), facts: [{ text, evidence: [] }] })
        expect(stallLimitMs(fact('The threshold was 1 s (1.3 s for an error), set from this stream\'s own rhythm: p95 gap 266 ms over 11 gaps.'))).toBe(1000)
        expect(stallLimitMs(fact('The threshold was 3.3 s (5 s for an error).'))).toBe(3350)
        expect(stallLimitMs(fact('The threshold was 400 ms (2 s for an error).'))).toBe(401)
        expect(stallLimitMs(fact('The threshold was 30 s: the stream has no measured cadence yet, so the default applies.'))).toBe(30_000)
        expect(stallLimitMs(fact('The threshold was 2 s, the longest silence the stream profile allows.'))).toBe(2000)
        expect(stallLimitMs(fact('The threshold was NaN s'))).toBeUndefined()
        expect(stallLimitMs(fact('No bytes arrived for 3.0 s.'))).toBeUndefined()
        expect(stallLimitMs({ ...finding('stall.silent:bytes', 'error'), facts: [] })).toBeUndefined()
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
