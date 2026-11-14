// @vitest-environment node
import { describe, expect, it } from 'vitest'
import fc from 'fast-check'
import { bytesToBase64 } from '../base64'
import { newHeader, parseCapture, serializeCapture, type Capture } from '../format'
import { POLICY_LIMITS, describePolicy, isCustomPolicy, parseRedactionPolicy, policyToJson } from '../policy'
import { redactCapture } from '../redact'

const valid = { version: 1, extraKeys: ['ssn', 'internalNote'], extraPatterns: [{ name: 'ticket', pattern: 'ACME-\\d{6}', flags: 'i' }], keepHeaders: ['X-Request-Id'], redactPartitions: false }

describe('parseRedactionPolicy', () => {
    it('reads a full policy from text or from an object', () => {
        for (const input of [JSON.stringify(valid), valid]) {
            const r = parseRedactionPolicy(input)
            expect(r.errors).toEqual([])
            expect(r.policy).toEqual({ extraKeys: ['ssn', 'internalNote'], extraPatterns: [{ name: 'ticket', pattern: 'ACME-\\d{6}', flags: 'i' }], keepHeaders: ['x-request-id'], redactPartitions: false })
        }
    })

    it('says there is no policy for empty text, without an error', () => {
        expect(parseRedactionPolicy('')).toEqual({ errors: [] })
        expect(parseRedactionPolicy('  \n')).toEqual({ errors: [] })
        expect(parseRedactionPolicy({})).toEqual({ errors: [] })
    })

    it('lists every problem at once, and then uses none of the policy', () => {
        const r = parseRedactionPolicy({ version: 2, nope: 1, extraKeys: ['ok', '', 3], extraPatterns: [{ name: 'bad name', pattern: '(' }], keepHeaders: ['Authorization', 'x y'], redactPartitions: 'yes' })
        expect(r.policy).toBeUndefined()
        expect(r.errors.join('\n')).toContain('Unknown field "nope"')
        expect(r.errors.join('\n')).toContain('"version" must be 1')
        expect(r.errors.join('\n')).toContain('"extraKeys[1]"')
        expect(r.errors.join('\n')).toContain('"extraKeys[2]"')
        expect(r.errors.join('\n')).toContain('extraPatterns[0].name')
        expect(r.errors.join('\n')).toContain('not a valid regular expression')
        expect(r.errors.join('\n')).toContain('"Authorization" carries credentials')
        expect(r.errors.join('\n')).toContain('"x y" is not a header name')
        expect(r.errors.join('\n')).toContain('"redactPartitions" must be true or false')
    })

    it('reports text that is not JSON, and JSON that is not an object', () => {
        expect(parseRedactionPolicy('{ nope').errors[0]).toMatch(/not valid JSON/)
        expect(parseRedactionPolicy('[1]').errors[0]).toMatch(/must be a JSON object/)
        expect(parseRedactionPolicy('"x"').errors[0]).toMatch(/must be a JSON object/)
    })

    it('refuses a pattern that matches the empty string, or that can take exponential time', () => {
        expect(parseRedactionPolicy({ extraPatterns: [{ name: 'a', pattern: 'x*' }] }).errors[0]).toMatch(/empty string/)
        for (const pattern of ['(a+)+$', '(.*)*x', '(\\w+\\s?)*end', '(a+){2,}']) {
            expect(parseRedactionPolicy({ extraPatterns: [{ name: 'a', pattern }] }).errors[0], pattern).toMatch(/exponentially/)
        }
        expect(parseRedactionPolicy({ extraPatterns: [{ name: 'a', pattern: 'ACME-\\d{6}' }] }).errors).toEqual([])
    })

    it('refuses flags that change how matching advances, and repeated flags', () => {
        for (const flags of ['g', 'y', 'd', 'ii', 'x']) {
            expect(parseRedactionPolicy({ extraPatterns: [{ name: 'a', pattern: 'abc', flags }] }).errors[0], flags).toMatch(/flags/)
        }
        expect(parseRedactionPolicy({ extraPatterns: [{ name: 'a', pattern: 'abc', flags: 'ims' }] }).errors).toEqual([])
    })

    it('keeps the number and the length of what a person writes inside limits', () => {
        const many = Array.from({ length: POLICY_LIMITS.keys + 1 }, (_, i) => `k${i}`)
        expect(parseRedactionPolicy({ extraKeys: many }).errors[0]).toMatch(/most allowed is 100/)
        expect(parseRedactionPolicy({ extraKeys: ['x'.repeat(POLICY_LIMITS.keyLength + 1)] }).errors[0]).toMatch(/characters/)
        expect(parseRedactionPolicy({ extraPatterns: [{ name: 'a', pattern: 'a'.repeat(POLICY_LIMITS.patternLength + 1) }] }).errors[0]).toMatch(/characters/)
        const patterns = Array.from({ length: POLICY_LIMITS.patterns + 1 }, (_, i) => ({ name: `p${i}`, pattern: `abc${i}` }))
        expect(parseRedactionPolicy({ extraPatterns: patterns }).errors[0]).toMatch(/most allowed is 20/)
    })

    it('never lets a header with credentials be kept, whatever its spelling', () => {
        for (const h of ['cookie', 'Set-Cookie', 'AUTHORIZATION', 'Proxy-Authorization', 'x-api-token', 'X-Client-Secret']) {
            expect(parseRedactionPolicy({ keepHeaders: [h] }).errors.length, h).toBe(1)
        }
    })

    it('gives back what it was given: text to policy to text to policy', () => {
        fc.assert(fc.property(
            fc.record({
                extraKeys: fc.option(fc.array(fc.stringMatching(/^[a-z][a-zA-Z0-9_-]{0,20}$/), { maxLength: 8 }), { nil: undefined }),
                keepHeaders: fc.option(fc.array(fc.constantFrom('x-request-id', 'X-Trace-Id', 'x-region', 'via'), { maxLength: 4 }), { nil: undefined }),
                redactPartitions: fc.option(fc.boolean(), { nil: undefined }),
            }),
            (raw) => {
                const first = parseRedactionPolicy(JSON.parse(JSON.stringify(raw)))
                if (first.errors.length > 0) return true // some random names are sensitive: that is the refusal, not a failure
                const second = parseRedactionPolicy(policyToJson(first.policy))
                return JSON.stringify(second.policy) === JSON.stringify(first.policy)
            },
        ), { seed: 14, numRuns: 300 })
    })
})

describe('describing a policy', () => {
    it('says what it adds, and says nothing is added when nothing is', () => {
        expect(describePolicy(undefined)).toBe('the built-in rules only')
        expect(describePolicy({})).toBe('the built-in rules only')
        expect(describePolicy({ redactPartitions: true })).toBe('the built-in rules only')
        expect(describePolicy(parseRedactionPolicy(valid).policy)).toBe('2 extra key names, 1 extra pattern, 1 kept header, partition keys kept')
        expect(isCustomPolicy({ extraKeys: ['a'] })).toBe(true)
    })
})

const BODY = [
    'id: 1\ndata: {"user":"ann","ssn":"123-45-6789","note":"see ACME-123456 for details"}\n\n',
    'id: 2\ndata: {"user":"bob","internalNote":"call me","n":2}\n\n',
].join('')
const capture = (): Capture => {
    const bytes = new TextEncoder().encode(BODY)
    return {
        header: newHeader({ kind: 'local-full', source: { kind: 'fixture' }, request: { url: 'http://x.test/s', method: 'GET', headers: { 'x-request-id': 'req-7f3a', accept: 'text/event-stream' } } }),
        records: [{ seq: 0, t: 0, conn: 0, kind: 'chunk', bytes: bytes.length, b64: bytesToBase64(bytes) }],
    }
}

describe('redacting with a policy', () => {
    const policy = parseRedactionPolicy(valid).policy!

    it('replaces what the policy names, and counts it under the rule name', () => {
        const { capture: out, report } = redactCapture(capture(), policy)
        const text = serializeCapture(out)
        expect(text).not.toContain('123-45-6789')
        expect(text).not.toContain('ACME-123456')
        expect(text).not.toContain('call me')
        expect(report.byRule['ticket']).toBe(1)
        expect(text).toContain('user\\":\\"ann') // not named, not touched
    })

    it('does nothing extra without the policy', () => {
        const text = serializeCapture(redactCapture(capture()).capture)
        expect(text).toContain('ACME-123456')
    })

    it('keeps a header the policy lets through, and not one it does not', () => {
        const withPolicy = redactCapture(capture(), policy).capture.header.request?.headers ?? {}
        expect(withPolicy['x-request-id']).toBe('req-7f3a')
        const without = redactCapture(capture()).capture.header.request?.headers ?? {}
        expect(without['x-request-id']).not.toBe('req-7f3a')
    })

    it('says in the file that custom rules were used, and the file still reads back', () => {
        const { capture: out } = redactCapture(capture(), policy)
        expect(out.header.redaction?.policy).toBe('custom')
        expect(redactCapture(capture()).capture.header.redaction?.policy).toBe('default')
        const again = parseCapture(serializeCapture(out))
        expect(again.capture.header.redaction?.policy).toBe('custom')
    })

    it('is idempotent: redacting a redacted capture with the same policy changes nothing more', () => {
        const once = serializeCapture(redactCapture(capture(), policy).capture)
        const twice = serializeCapture(redactCapture(parseCapture(once).capture, policy).capture)
        expect(JSON.parse(twice.split('\n')[0]!).redaction.policy).toBe('custom')
        expect(twice.split('\n').slice(1, -1)).toEqual(once.split('\n').slice(1, -1))
    })
})
