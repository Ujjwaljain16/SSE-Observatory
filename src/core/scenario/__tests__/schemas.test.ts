// @vitest-environment node
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import Ajv2020 from 'ajv/dist/2020'
import { CAPTURE_SCHEMA, SCENARIO_SCHEMA, type Schema } from '../schema'
import { validateJson } from '../validate'
import { newHeader, serializeCapture, type Capture } from '../../capture/format'
import { capture as build } from '../../testing/captureBuilder'

const publicFile = (name: string): unknown => JSON.parse(readFileSync(resolve(__dirname, '../../../../docs/public/schemas', name), 'utf8'))

describe('published schema files', () => {
    it('are exactly the schemas in the code', () => {
        expect(publicFile('sse-scenario-1.json')).toEqual(SCENARIO_SCHEMA)
        expect(publicFile('sse-capture-2.json')).toEqual(CAPTURE_SCHEMA)
    })

    it('use only the keywords the built-in validator implements', () => {
        const KEYWORDS = new Set(['type', 'required', 'enum', 'const', 'properties', 'additionalProperties', 'items', 'minimum', 'maximum', 'minLength', 'pattern', 'minProperties', 'maxProperties', 'oneOf', '$schema', '$id', 'title', 'description'])
        const bad: string[] = []
        const walk = (s: Schema, path: string): void => {
            for (const key of Object.keys(s)) if (!KEYWORDS.has(key)) bad.push(`${path}: ${key}`)
            if (s.type !== undefined && typeof s.type !== 'string') bad.push(`${path}: type must be a single string`)
            for (const [name, sub] of Object.entries(s.properties ?? {})) walk(sub, `${path}/properties/${name}`)
            if (typeof s.additionalProperties === 'object') walk(s.additionalProperties, `${path}/additionalProperties`)
            if (s.items) walk(s.items, `${path}/items`)
            s.oneOf?.forEach((b, i) => walk(b, `${path}/oneOf/${i}`))
        }
        walk(SCENARIO_SCHEMA, '#')
        walk(CAPTURE_SCHEMA, '#')
        expect(bad).toEqual([])
    })
})

const GOOD = {
    version: 1,
    name: 'orders stream resumes after a dropped connection',
    target: { url: '${ENV:STREAM_URL}', headers: { Authorization: 'Bearer ${ENV:STREAM_TOKEN}' }, sequence: { field: '$.seq', policy: 'consecutive' }, delivery: 'at_least_once' },
    expect: { status: 200, content_type: 'text/event-stream', first_event_within_ms: 3000 },
    steps: [{ collect_events: 20, timeout_ms: 20000 }, { disconnect: { mode: 'client' } }, { reconnect: { after_ms: 500, resume_from_last_event_id: true } }, { collect_events: 20, timeout_ms: 20000 }],
    verify: ['no_unexplained_sequence_gaps', 'no_unexpected_duplicates', 'preserve_event_order', { no_findings_at_or_above: 'warning' }],
    fail_on_severity: 'error',
    meta: { notes: [] },
}
const mod = (patch: (d: Record<string, any>) => void): unknown => { const d = structuredClone(GOOD) as Record<string, any>; patch(d); return d }

const VALID: Array<[string, unknown]> = [
    ['documented example', GOOD],
    ['minimal', { version: 1, name: 'x', target: { url: 'https://a.test/e' }, steps: [{ collect_events: 1 }] }],
    ['fixture target', mod((d) => { d.target = { url: 'fixture://F05' } })],
    ['env url with path', mod((d) => { d.target = { url: '${ENV:BASE}/events' } })],
    ['replay target', mod((d) => { d.target = { replay: { capture: 'a.sse-capture', honor_last_event_id: true, test_aids: { drop_after: 3, skip_ids: ['4'] } }, delivery: 'exactly_once' } })],
    ['use_sse_id sequence', mod((d) => { d.target.sequence = { use_sse_id: true, policy: 'monotonic' } })],
    ['wait step', mod((d) => { d.steps = [{ wait: { ms: 10 } }, { reconnect: {} }] })],
    ['server disconnect', mod((d) => { d.steps = [{ disconnect: { mode: 'server' } }] })],
    ['allow_gaps', mod((d) => { d.allow_gaps = [{ from: 1, to: 2 }] })],
    ['meta anything', mod((d) => { d.meta = { origin: 'https://a.test', whatever: [1, { a: null }] } })],
    ['$schema', mod((d) => { d.$schema = 'https://example.test/s.json' })],
    ['empty steps and verify', mod((d) => { d.steps = []; d.verify = [] })],
]

const INVALID: Array<[string, unknown]> = [
    ['not an object', []],
    ['missing steps', mod((d) => { delete d.steps })],
    ['missing target', mod((d) => { delete d.target })],
    ['wrong version', mod((d) => { d.version = 2 })],
    ['version as string', mod((d) => { d.version = '1' })],
    ['empty name', mod((d) => { d.name = '' })],
    ['unknown top-level key', mod((d) => { d.extra = 1 })],
    ['target with neither url nor replay', mod((d) => { d.target = { delivery: 'at_least_once' } })],
    ['target with both', mod((d) => { d.target.replay = { capture: 'a' } })],
    ['unknown target key', mod((d) => { d.target.proxy = 'x' })],
    ['bad url scheme', mod((d) => { d.target.url = 'ftp://a.test' })],
    ['header value not a string', mod((d) => { d.target.headers.X = 1 })],
    ['sequence without field or sse id', mod((d) => { d.target.sequence = { policy: 'consecutive' } })],
    ['sequence with both', mod((d) => { d.target.sequence = { field: '$.a', use_sse_id: true, policy: 'consecutive' } })],
    ['sequence path without $.', mod((d) => { d.target.sequence.field = 'seq' })],
    ['sequence policy unknown', mod((d) => { d.target.sequence.policy = 'random' })],
    ['sequence without policy', mod((d) => { delete d.target.sequence.policy })],
    ['use_sse_id false', mod((d) => { d.target.sequence = { use_sse_id: false, policy: 'consecutive' } })],
    ['delivery unknown', mod((d) => { d.target.delivery = 'sometimes' })],
    ['replay without capture', mod((d) => { d.target = { replay: {} } })],
    ['replay drop_after zero', mod((d) => { d.target = { replay: { capture: 'a', test_aids: { drop_after: 0 } } } })],
    ['skip_ids not strings', mod((d) => { d.target = { replay: { capture: 'a', test_aids: { skip_ids: [1] } } } })],
    ['status out of range', mod((d) => { d.expect.status = 99 })],
    ['status fractional', mod((d) => { d.expect.status = 200.5 })],
    ['unknown expect key', mod((d) => { d.expect.body = 'x' })],
    ['first event zero', mod((d) => { d.expect.first_event_within_ms = 0 })],
    ['steps not an array', mod((d) => { d.steps = {} })],
    ['unknown step', mod((d) => { d.steps = [{ explode: true }] })],
    ['step with two actions', mod((d) => { d.steps = [{ wait: { ms: 1 }, disconnect: { mode: 'client' } }] })],
    ['collect_events zero', mod((d) => { d.steps = [{ collect_events: 0 }] })],
    ['collect_events string', mod((d) => { d.steps = [{ collect_events: '3' }] })],
    ['timeout on a wait step', mod((d) => { d.steps = [{ wait: { ms: 1 }, timeout_ms: 5 }] })],
    ['disconnect without mode', mod((d) => { d.steps = [{ disconnect: {} }] })],
    ['disconnect bad mode', mod((d) => { d.steps = [{ disconnect: { mode: 'both' } }] })],
    ['reconnect negative delay', mod((d) => { d.steps = [{ reconnect: { after_ms: -1 } }] })],
    ['reconnect unknown key', mod((d) => { d.steps = [{ reconnect: { later: true } }] })],
    ['wait without ms', mod((d) => { d.steps = [{ wait: {} }] })],
    ['verify unknown name', mod((d) => { d.verify = ['be_nice'] })],
    ['verify severity object bad', mod((d) => { d.verify = [{ no_findings_at_or_above: 'loud' }] })],
    ['verify empty object', mod((d) => { d.verify = [{}] })],
    ['verify object two keys', mod((d) => { d.verify = [{ no_findings_at_or_above: 'info', other: 1 }] })],
    ['verify number', mod((d) => { d.verify = [3] })],
    ['fail_on_severity unknown', mod((d) => { d.fail_on_severity = 'fatal' })],
    ['allow_gaps missing to', mod((d) => { d.allow_gaps = [{ from: 1 }] })],
    ['allow_gaps fractional', mod((d) => { d.allow_gaps = [{ from: 1.5, to: 2 }] })],
    ['meta not an object', mod((d) => { d.meta = [] })],
]

describe('built-in validator agrees with Ajv', () => {
    const ajv = new Ajv2020({ allErrors: true, strict: true })
    const ajvScenario = ajv.compile(SCENARIO_SCHEMA as object)
    const ajvCapture = ajv.compile(CAPTURE_SCHEMA as object)

    it('compiles both schemas in strict mode', () => {
        expect(typeof ajvScenario).toBe('function')
        expect(typeof ajvCapture).toBe('function')
    })

    for (const [name, doc] of VALID) {
        it(`valid: ${name}`, () => {
            expect(ajvScenario(doc), 'ajv').toBe(true)
            expect(validateJson(SCENARIO_SCHEMA, doc)).toEqual([])
        })
    }
    for (const [name, doc] of INVALID) {
        it(`invalid: ${name}`, () => {
            expect(ajvScenario(doc), 'ajv').toBe(false)
            expect(validateJson(SCENARIO_SCHEMA, doc).length, 'built-in').toBeGreaterThan(0)
        })
    }

    describe('capture lines', () => {
        const header = newHeader({
            kind: 'sanitized', source: { kind: 'cli', client: 'node-undici' }, request: { url: 'http://s.test/e', method: 'GET', headers: { accept: 'text/event-stream' } },
            redaction: { policy: 'default', version: 1, applied: ['headers'], placeholders: 1 }, captureId: 'abc',
        })
        const records = build().connect().response().frame('message', '1').frame('message', '2').beat().retry(2000).silence(5000).reconnect({ lastEventIdSent: '2' }).connect({ sentLastEventId: '2' }).response().frame('message', '3').discontinuity(900, 'wake').end().build()
        const unknown = { seq: 99, t: 12.5, conn: 0, kind: 'from-the-future', payload: { a: [1, 2] }, count: 'whatever' }
        const file = serializeCapture({ header, records: [...records, unknown as never] } satisfies Capture)
        const lines = file.trimEnd().split('\n').map((l) => JSON.parse(l) as Record<string, unknown>)

        it('accepts every line of a real capture: header, records, unknown kind, footer', () => {
            expect(lines.length).toBe(records.length + 3)
            for (const line of lines) {
                expect(ajvCapture(line), JSON.stringify(line) + JSON.stringify(ajvCapture.errors)).toBe(true)
                expect(validateJson(CAPTURE_SCHEMA, line), JSON.stringify(line)).toEqual([])
            }
        })

        it('accepts a local-full record with wire bytes and a header from a newer minor version', () => {
            const chunk = { seq: 0, t: 0, conn: 0, domain: 'transport', kind: 'chunk', bytes: 4, b64: 'ZGF0YQ==' }
            const newer = { ...lines[0]!, version: '2.7', someNewField: { a: 1 } }
            for (const line of [chunk, newer]) {
                expect(ajvCapture(line)).toBe(true)
                expect(validateJson(CAPTURE_SCHEMA, line)).toEqual([])
            }
        })

        const badLines: Array<[string, unknown]> = [
            ['record without conn', { kind: 'chunk', seq: 1, t: 0 }],
            ['record without kind', { seq: 1, t: 0, conn: 0 }],
            ['negative time', { kind: 'chunk', seq: 1, t: -1, conn: 0 }],
            ['fractional seq', { kind: 'chunk', seq: 1.5, t: 0, conn: 0 }],
            ['payload field with the wrong type', { kind: 'chunk', seq: 1, t: 0, conn: 0, bytes: 'ten' }],
            ['bad domain', { kind: 'chunk', seq: 1, t: 0, conn: 0, domain: 'moon' }],
            ['major version 1 header', { ...lines[0]!, version: '1.0' }],
            ['header without source', (() => { const { source: _s, ...rest } = lines[0]!; return rest })()],
            ['header bad kind', { ...lines[0]!, kind: 'secret' }],
            ['footer without counts', { footer: { endReason: 'completed' } }],
            ['footer with a bad hash', { footer: { endReason: 'completed', counts: {}, integrity: { algorithm: 'sha256', value: 'abc' } } }],
            ['footer with extra line keys', { footer: { endReason: 'completed', counts: {} }, junk: 1 }],
            ['empty object', {}],
            ['an array', []],
        ]
        for (const [name, line] of badLines) {
            it(`rejects ${name}`, () => {
                expect(ajvCapture(line), 'ajv').toBe(false)
                expect(validateJson(CAPTURE_SCHEMA, line).length, 'built-in').toBeGreaterThan(0)
            })
        }
    })
})
