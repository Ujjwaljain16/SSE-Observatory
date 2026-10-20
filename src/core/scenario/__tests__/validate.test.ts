// @vitest-environment node
import { describe, it, expect } from 'vitest'
import { validateJson, parseScenarioText, type ValidationError } from '../validate'
import type { Schema } from '../schema'
import { findSecrets } from '../secrets'

const pointers = (errors: ValidationError[]): string[] => errors.map((e) => e.pointer)

describe('validateJson keywords', () => {
    it('type: integer, number, string, boolean, null, array, object', () => {
        expect(validateJson({ type: 'integer' }, 3)).toEqual([])
        expect(validateJson({ type: 'integer' }, 3.5)).toHaveLength(1)
        expect(validateJson({ type: 'number' }, 3.5)).toEqual([])
        expect(validateJson({ type: 'number' }, '3')).toHaveLength(1)
        expect(validateJson({ type: 'string' }, 1)[0]!.message).toBe('must be a string (found an integer)')
        expect(validateJson({ type: 'boolean' }, 'yes')).toHaveLength(1)
        expect(validateJson({ type: 'null' }, null)).toEqual([])
        expect(validateJson({ type: 'array' }, {})).toHaveLength(1)
        expect(validateJson({ type: 'object' }, [])).toHaveLength(1)
        expect(validateJson({ type: 'object' }, null)).toHaveLength(1)
    })

    it('enum and const compare by value, including objects', () => {
        expect(validateJson({ enum: ['a', 'b'] }, 'a')).toEqual([])
        expect(validateJson({ enum: ['a', 'b'] }, 'c')[0]!.message).toBe('must be one of "a", "b"')
        expect(validateJson({ enum: [{ x: 1 }] }, { x: 1 })).toEqual([])
        expect(validateJson({ const: 1 }, 1)).toEqual([])
        expect(validateJson({ const: 1 }, '1')).toHaveLength(1)
        expect(validateJson({ const: false }, true)).toHaveLength(1)
    })

    it('minimum, maximum, minLength (in characters), pattern', () => {
        expect(validateJson({ minimum: 2 }, 1)[0]!.message).toBe('must be at least 2')
        expect(validateJson({ maximum: 2 }, 3)[0]!.message).toBe('must be at most 2')
        expect(validateJson({ minimum: 2, maximum: 2 }, 2)).toEqual([])
        expect(validateJson({ minLength: 1 }, '')[0]!.message).toBe('must not be empty')
        expect(validateJson({ minLength: 2 }, '𝄞')).toHaveLength(1) // one character, two UTF-16 units
        expect(validateJson({ minLength: 1 }, '𝄞')).toEqual([])
        expect(validateJson({ pattern: '^a+$' }, 'aaa')).toEqual([])
        expect(validateJson({ pattern: '^a+$' }, 'ab')).toHaveLength(1)
    })

    it('required, properties, additionalProperties false and as a schema, min/maxProperties', () => {
        const s: Schema = { type: 'object', required: ['a'], properties: { a: { type: 'string' } }, additionalProperties: false }
        expect(validateJson(s, { a: 'x' })).toEqual([])
        expect(validateJson(s, {})[0]).toEqual({ pointer: '', message: 'missing required property "a"' })
        expect(validateJson(s, { a: 'x', b: 1 })[0]).toEqual({ pointer: '/b', message: 'unknown property "b"' })
        const open: Schema = { type: 'object', properties: { a: { type: 'string' } }, additionalProperties: { type: 'integer' } }
        expect(validateJson(open, { a: 'x', b: 2 })).toEqual([])
        expect(pointers(validateJson(open, { a: 'x', b: 'no' }))).toEqual(['/b'])
        expect(validateJson({ minProperties: 1 }, {})).toHaveLength(1)
        expect(validateJson({ maxProperties: 1 }, { a: 1, b: 2 })).toHaveLength(1)
        expect(validateJson({ type: 'object' }, { anything: [1, 2] })).toEqual([])
    })

    it('items reports the index in the pointer', () => {
        const s: Schema = { type: 'array', items: { type: 'integer' } }
        expect(validateJson(s, [1, 2])).toEqual([])
        expect(pointers(validateJson(s, [1, 'x', 3, null]))).toEqual(['/1', '/3'])
    })

    it('escapes ~ and / in pointers', () => {
        const s: Schema = { type: 'object', properties: { 'a/b': { type: 'string' }, 'c~d': { type: 'string' } } }
        expect(pointers(validateJson(s, { 'a/b': 1, 'c~d': 2 }))).toEqual(['/a~1b', '/c~0d'])
    })

    it('oneOf needs exactly one match and reports the closest branch', () => {
        const s: Schema = {
            oneOf: [
                { type: 'object', properties: { a: { type: 'integer' } }, required: ['a'], additionalProperties: false },
                { type: 'object', properties: { b: { type: 'string' } }, required: ['b'], additionalProperties: false },
            ],
        }
        expect(validateJson(s, { a: 1 })).toEqual([])
        expect(validateJson(s, { b: 'x' })).toEqual([])
        expect(pointers(validateJson(s, { a: 'one' }))).toEqual(['/a'])
        const both: Schema = { oneOf: [{ type: 'integer' }, { type: 'number' }] }
        expect(validateJson(both, 1)[0]!.message).toBe('matches more than one of the allowed forms')
        // Equally far from both: say what each would need.
        expect(validateJson(s, {})[0]!.message).toBe('does not match any allowed form (missing required property "a" / missing required property "b")')
    })
})

const GOOD = {
    version: 1,
    name: 'orders stream resumes after a dropped connection',
    target: {
        url: '${ENV:STREAM_URL}',
        headers: { Authorization: 'Bearer ${ENV:STREAM_TOKEN}' },
        sequence: { field: '$.seq', policy: 'consecutive' },
        delivery: 'at_least_once',
    },
    expect: { status: 200, content_type: 'text/event-stream', first_event_within_ms: 3000 },
    steps: [
        { collect_events: 20, timeout_ms: 20000 },
        { disconnect: { mode: 'client' } },
        { reconnect: { after_ms: 500, resume_from_last_event_id: true } },
        { collect_events: 20, timeout_ms: 20000 },
    ],
    verify: ['no_unexplained_sequence_gaps', 'no_unexpected_duplicates', 'preserve_event_order', { no_findings_at_or_above: 'warning' }],
    fail_on_severity: 'error',
    meta: { notes: [] },
}

describe('parseScenarioText', () => {
    it('accepts the documented example', () => {
        const r = parseScenarioText(JSON.stringify(GOOD))
        expect(r.errors).toEqual([])
        expect(r.value?.name).toContain('orders stream')
    })

    it('points at the step and field that is wrong', () => {
        const bad = structuredClone(GOOD) as Record<string, unknown>
        ;(bad.steps as unknown[])[0] = { collect_events: 'twenty' }
        const r = parseScenarioText(JSON.stringify(bad))
        expect(r.value).toBeUndefined()
        expect(r.errors).toEqual([{ pointer: '/steps/0/collect_events', message: 'must be an integer (found a string)' }])
    })

    it('names an unknown step, unknown verify entry and unknown top-level key', () => {
        const bad = structuredClone(GOOD) as Record<string, unknown>
        ;(bad.steps as unknown[])[1] = { dissconnect: {} }
        ;(bad.verify as unknown[])[0] = 'be_nice'
        bad.extra = true
        const errors = parseScenarioText(JSON.stringify(bad)).errors
        expect(pointers(errors)).toContain('/extra')
        expect(errors.find((e) => e.pointer === '/steps/1')?.message).toMatch(/does not match any allowed form/)
        expect(pointers(errors).some((p) => p === '/verify/0')).toBe(true)
    })

    it('requires exactly one of target.url and target.replay', () => {
        const neither = { ...GOOD, target: { delivery: 'at_least_once' } }
        expect(parseScenarioText(JSON.stringify(neither)).errors[0]!.message).toMatch(/does not match any allowed form/)
        const both = { ...GOOD, target: { url: 'https://x.test/e', replay: { capture: 'a.sse-capture' } } }
        expect(parseScenarioText(JSON.stringify(both)).errors.length).toBeGreaterThan(0)
        const replay = { ...GOOD, target: { replay: { capture: 'a.sse-capture', honor_last_event_id: true, test_aids: { drop_after: 5, skip_ids: ['7'] } } } }
        expect(parseScenarioText(JSON.stringify(replay)).errors).toEqual([])
    })

    it('needs a sequence field or use_sse_id, not both', () => {
        const mk = (sequence: unknown) => JSON.stringify({ ...GOOD, target: { ...GOOD.target, sequence } })
        expect(parseScenarioText(mk({ use_sse_id: true, policy: 'monotonic' })).errors).toEqual([])
        expect(parseScenarioText(mk({ policy: 'monotonic' })).errors.length).toBeGreaterThan(0)
        expect(parseScenarioText(mk({ field: '$.seq', use_sse_id: true, policy: 'monotonic' })).errors.length).toBeGreaterThan(0)
        expect(parseScenarioText(mk({ field: 'seq', policy: 'monotonic' })).errors.map((e) => e.pointer)).toContain('/target/sequence/field')
    })

    it('accepts urls of the three kinds and rejects others', () => {
        const mk = (url: string) => parseScenarioText(JSON.stringify({ ...GOOD, target: { url } })).errors
        expect(mk('https://stream.example.com/events')).toEqual([])
        expect(mk('http://localhost:3000/e')).toEqual([])
        expect(mk('fixture://F05')).toEqual([])
        expect(mk('${ENV:BASE}/events')).toEqual([])
        expect(mk('ftp://x.test')).toHaveLength(1)
        expect(mk('stream.example.com')).toHaveLength(1)
    })

    it('checks the step payloads', () => {
        const run = (step: unknown) => parseScenarioText(JSON.stringify({ ...GOOD, steps: [step] })).errors
        expect(run({ wait: { ms: 100 } })).toEqual([])
        expect(run({ disconnect: { mode: 'server' } })).toEqual([])
        expect(run({ reconnect: {} })).toEqual([])
        expect(pointers(run({ disconnect: { mode: 'both' } }))).toEqual(['/steps/0/disconnect/mode'])
        expect(pointers(run({ collect_events: 0 }))).toEqual(['/steps/0/collect_events'])
        expect(run({ wait: { ms: 1 }, collect_events: 2 }).length).toBeGreaterThan(0)
    })

    it('verify objects take one severity, allow_gaps takes ranges', () => {
        const run = (extra: Record<string, unknown>) => parseScenarioText(JSON.stringify({ ...GOOD, ...extra })).errors
        expect(run({ verify: [{ no_findings_at_or_above: 'critical' }] })).toEqual([])
        expect(run({ verify: [{ no_findings_at_or_above: 'loud' }] }).length).toBeGreaterThan(0)
        expect(run({ verify: [{}] }).length).toBeGreaterThan(0)
        expect(run({ allow_gaps: [{ from: 3, to: 5 }] })).toEqual([])
        expect(pointers(run({ allow_gaps: [{ from: 3 }] }))).toEqual(['/allow_gaps/0'])
        expect(pointers(run({ fail_on_severity: 'fatal' }))).toEqual(['/fail_on_severity'])
    })
})

describe('JSON syntax errors', () => {
    it('report line and column', () => {
        const text = '{\n  "version": 1,\n  "name": "x",\n  "steps": [,]\n}'
        const [e] = parseScenarioText(text).errors
        expect(e).toMatchObject({ code: 'syntax', line: 4, column: 13 })
        expect(e!.message).toContain('line 4, column 13')
    })

    it('locates the usual mistakes the same way on every engine', () => {
        const at = (text: string) => { const e = parseScenarioText(text).errors[0]!; return `${e.line}:${e.column}` }
        expect(at('{\n  "a": 1,\n}')).toBe('3:1') // trailing comma
        expect(at("{ 'a': 1 }")).toBe('1:3') // single quotes
        expect(at('{\n  "a": "x\ny"\n}')).toBe('2:10') // raw line break in a string
        expect(at('{"a": 1} x')).toBe('1:10') // text after the value
        expect(at('{"a" 1}')).toBe('1:6') // missing colon
        expect(at('[1 2]')).toBe('1:4')
        expect(at('{"a": tru}')).toBe('1:7')
        expect(at('{"a": 01}')).toBe('1:8')
        expect(at('{"a": "\\q"}')).toBe('1:8')
    })

    it('handles a cut-off file, an empty file and a byte order mark', () => {
        const cut = parseScenarioText('{\n  "version": 1,')
        expect(cut.errors[0]).toMatchObject({ code: 'syntax', line: 2, column: 16 })
        expect(parseScenarioText('  \n').errors[0]!.message).toBe('the scenario file is empty')
        expect(parseScenarioText('﻿' + JSON.stringify(GOOD)).errors).toEqual([])
    })
})

describe('secret rule', () => {
    const withHeaders = (headers: Record<string, string>) => parseScenarioText(JSON.stringify({ ...GOOD, target: { ...GOOD.target, headers } }))

    it('accepts placeholders after a scheme word, alone, or in a cookie pair', () => {
        for (const value of ['Bearer ${ENV:STREAM_TOKEN}', 'Basic ${ENV:BASIC}', '${ENV:STREAM_AUTHORIZATION}', 'sid=${ENV:SID}']) {
            expect(withHeaders({ Authorization: value }).errors, value).toEqual([])
        }
        expect(withHeaders({ 'X-Api-Key': '${ENV:K}', Accept: 'text/event-stream' }).errors).toEqual([])
    })

    it('rejects literal values in sensitive headers, with a code and without echoing the value', () => {
        for (const name of ['Authorization', 'authorization', 'Cookie', 'X-API-Key', 'Proxy-Authorization', 'Set-Cookie', 'X-Auth-Token']) {
            const r = withHeaders({ [name]: 'Bearer abc123' })
            expect(r.value, name).toBeUndefined()
            expect(r.errors).toHaveLength(1)
            expect(r.errors[0]).toMatchObject({ code: 'secret', pointer: `/target/headers/${name}` })
            expect(r.errors[0]!.message).not.toContain('abc123')
        }
        expect(withHeaders({ Authorization: 'Bearer ${ENV:A} extra' }).errors[0]!.code).toBe('secret')
        expect(withHeaders({ Authorization: 'Bearer' }).errors[0]!.code).toBe('secret')
    })

    it('rejects sensitive query parameters with a literal value', () => {
        const url = (u: string) => parseScenarioText(JSON.stringify({ ...GOOD, target: { url: u } })).errors
        for (const name of ['token', 'key', 'secret', 'password', 'auth', 'session', 'jwt', 'api_key', 'access_token', 'API-KEY']) {
            const errors = url(`https://x.test/e?${name}=hunter2`)
            expect(errors, name).toHaveLength(1)
            expect(errors[0]).toMatchObject({ code: 'secret', pointer: '/target/url' })
            expect(errors[0]!.message).not.toContain('hunter2')
        }
        expect(url('https://x.test/e?token=${ENV:T}&topic=orders')).toEqual([])
        expect(url('https://x.test/e?topic=orders&limit=5')).toEqual([])
        expect(url('https://x.test/e?token=')).toEqual([])
        expect(url('https://user:hunter2@x.test/e')[0]!.code).toBe('secret')
        expect(url('https://user:${ENV:P}@x.test/e')).toEqual([])
    })

    it('rejects JWT-shaped and long key-looking strings anywhere', () => {
        const jwt = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dBjftJeZ4CVPmB92K27uhbUJU1p1r'
        const inName = parseScenarioText(JSON.stringify({ ...GOOD, name: `uses ${jwt}` }))
        expect(inName.errors[0]).toMatchObject({ code: 'secret', pointer: '/name' })
        const inNotes = parseScenarioText(JSON.stringify({ ...GOOD, meta: { notes: ['fine', 'a'.repeat(32).replace(/a/g, 'f')] } }))
        expect(inNotes.errors[0]).toMatchObject({ code: 'secret', pointer: '/meta/notes/1' })
        const b64 = parseScenarioText(JSON.stringify({ ...GOOD, meta: { key: 'sk_Live9aB3cD4eF5gH6iJ7kL8mN9oP0qR1sT2uV3wX' } }))
        expect(b64.errors[0]).toMatchObject({ code: 'secret', pointer: '/meta/key' })
    })

    it('does not flag ordinary text, hostnames, paths or placeholders', () => {
        const fine = { ...GOOD, name: 'orders stream resumes after a dropped connection, 20 events each side', meta: { notes: ['Set these environment variables before running: STREAM_URL, STREAM_AUTHORIZATION.', 'captures/orders/stream_resume_after_drop_with_a_long_descriptive_file_name.sse-capture'] } }
        expect(parseScenarioText(JSON.stringify(fine)).errors).toEqual([])
        expect(findSecrets({ $schema: 'https://sse-observatory.vercel.app/docs/schemas/sse-scenario-1.json' })).toEqual([])
    })
})
