import { describe, it, expect } from 'vitest'
import fc from 'fast-check'
import { QueryParser, QueryParseError, compileQueryString, parseQuery, type QueryNode } from '../queryParser'
import type { EventMessage } from '../../types'

const ev = (data: unknown, extra: Partial<EventMessage> = {}) =>
    ({ id: '1', type: 'message', timestamp: 't', raw: '', data, ...extra }) as unknown as EventMessage
const run = (q: string, data: unknown, extra: Partial<EventMessage> = {}) => compileQueryString(q)(ev(data, extra))

describe('QueryParser (class API)', () => {
    it('parses simple equality into the documented AST shape', () => {
        expect(new QueryParser('level == "error"').parse()).toEqual({ type: 'comparison', operator: '==', left: 'level', right: 'error' })
    })

    it('compile() accepts an AST produced elsewhere (worker protocol)', () => {
        const parser = new QueryParser('')
        const ast: QueryNode = { type: 'comparison', operator: '>=', left: 'n', right: 5 }
        expect(parser.compile(ast)(ev({ n: 5 }))).toBe(true)
        expect(parser.compile(ast)(ev({ n: 4 }))).toBe(false)
    })
})

describe('operators', () => {
    it('>= and <= are real operators (not silently > and <)', () => {
        expect(run('data.level >= 3', { level: 3 })).toBe(true)
        expect(run('data.level >= 3', { level: 2 })).toBe(false)
        expect(run('n <= 3', { n: 3 })).toBe(true)
        expect(run('n < 3', { n: 3 })).toBe(false)
        expect(run('n > 3', { n: 3 })).toBe(false)
    })

    it('numeric comparison needs numbers on both sides', () => {
        expect(run('n > 1', { n: 'abc' })).toBe(false)
        expect(run('n > 1', {})).toBe(false)
        expect(run('n > 1', { n: '' })).toBe(false)
        expect(run('n > 1', { n: '10' })).toBe(true)
    })

    it('equality works across string/number/boolean/null', () => {
        expect(run('n == 5', { n: 5 })).toBe(true)
        expect(run('n == 5', { n: '5' })).toBe(true)
        expect(run('n == 5', { n: '05' })).toBe(true)
        expect(run('n == 5', { n: 'x' })).toBe(false)
        expect(run('ok == true', { ok: true })).toBe(true)
        expect(run('ok == false', { ok: true })).toBe(false)
        expect(run('x == null', { x: null })).toBe(true)
        expect(run('x == null', {})).toBe(true)
        expect(run('x != null', { x: 1 })).toBe(true)
        expect(run('s != "a"', { s: 'b' })).toBe(true)
        expect(run('s = "a"', { s: 'a' })).toBe(true) // single = is accepted as ==
    })

    it('contains is case-insensitive; matches is a case-insensitive regex', () => {
        expect(run('message contains "TIMEOUT"', { message: 'Connection timeout occurred' })).toBe(true)
        expect(run('message contains "x"', {})).toBe(false)
        expect(run('requestId matches "^REQ-\\d+$"', { requestId: 'REQ-1234' })).toBe(true)
        expect(run('requestId matches "^REQ-\\d+$"', { requestId: 'REQ-ABCD' })).toBe(false)
        expect(run('requestId matches "^req"', { requestId: 'REQ-1' })).toBe(true)
    })

    it('in [..] and exists', () => {
        expect(run('level in ["warn","error"]', { level: 'error' })).toBe(true)
        expect(run('level in ["warn","error"]', { level: 'info' })).toBe(false)
        expect(run('code in [200, 201]', { code: 201 })).toBe(true)
        expect(run('level in []', { level: 'x' })).toBe(false)
        expect(run('user.id exists', { user: { id: 0 } })).toBe(true)
        expect(run('user.id exists', { user: {} })).toBe(false)
    })

    it('reads root fields too', () => {
        expect(run('type == "error"', {}, { type: 'error' })).toBe(true)
        expect(run('parsedType == "order"', {}, { parsedType: 'order' })).toBe(true)
    })
})

describe('logic and precedence', () => {
    it('AND binds tighter than OR, NOT binds tightest, parens override', () => {
        const d = { a: 1, b: 0, c: 1 }
        expect(run('a == 1 OR b == 1 AND c == 0', d)).toBe(true) // a || (b && c)
        expect(run('(a == 1 OR b == 1) AND c == 0', d)).toBe(false)
        expect(run('NOT b == 1', d)).toBe(true)
        expect(run('NOT (a == 1 AND c == 1)', d)).toBe(false)
        expect(run('not not a == 1', d)).toBe(true)
    })

    it('keywords are case-insensitive', () => {
        expect(run('a == 1 and b == 0', { a: 1, b: 0 })).toBe(true)
        expect(run('a == 1 Or b == 9', { a: 0, b: 9 })).toBe(true)
    })
})

describe('field names and values that used to break', () => {
    it('fields that start with a keyword are plain fields', () => {
        expect(run('ORDER_ID == 5', { ORDER_ID: 5 })).toBe(true)
        expect(run('ANDROID == 1', { ANDROID: 1 })).toBe(true)
        expect(run('containsAll == 1', { containsAll: 1 })).toBe(true)
        expect(run('notes == "x"', { notes: 'x' })).toBe(true)
        expect(run('index == 2', { index: 2 })).toBe(true)
    })

    it('hyphens, colons, array indexes and quoted fields', () => {
        expect(run('data.user-id == 5', { 'user-id': 5 })).toBe(true)
        expect(run('x-request-id == "abc"', { 'x-request-id': 'abc' })).toBe(true)
        expect(run('items[1].id == 9', { items: [{ id: 1 }, { id: 9 }] })).toBe(true)
        expect(run('"weird.key" == 1', { weird: { key: 1 } })).toBe(true)
    })

    it('negative numbers keep their sign', () => {
        expect(run('t > -5', { t: -3 })).toBe(true)
        expect(run('t > -5', { t: -9 })).toBe(false)
        expect(run('t < -5', { t: 5 })).toBe(false)
        expect(run('t == -1.5', { t: -1.5 })).toBe(true)
        expect(run('t == 1e3', { t: 1000 })).toBe(true)
    })

    it('barewords as values, quotes and escapes', () => {
        expect(run('status == active', { status: 'active' })).toBe(true)
        expect(run('type == foo-bar', {}, { type: 'foo-bar' })).toBe(true)
        expect(run('d == 2024-01-01', { d: '2024-01-01' })).toBe(true)
        expect(run("s == 'it\\'s'", { s: "it's" })).toBe(true)
        expect(run('s == "a\\"b"', { s: 'a"b' })).toBe(true)
        expect(run('s == "line\\nbreak"', { s: 'line\nbreak' })).toBe(true)
    })
})

describe('errors', () => {
    const msg = (q: string) => {
        try { parseQuery(q); return 'no error' } catch (e) {
            expect(e).toBeInstanceOf(QueryParseError)
            return (e as Error).message
        }
    }

    it('give position-aware, human messages instead of internal TypeErrors', () => {
        expect(msg('')).toMatch(/Empty query/)
        expect(msg('   ')).toMatch(/Empty query/)
        expect(msg('type ==')).toMatch(/end of query.*expected a value/)
        expect(msg('type "x"')).toMatch(/expected an operator/)
        expect(msg('level == "error" AND OR')).toMatch(/"OR".*expected a field name/)
        expect(msg('(a == 1')).toMatch(/expected "\)"/)
        expect(msg('a == 1)')).toMatch(/Unexpected "\)" at position 6/)
        expect(msg('a == "x')).toMatch(/Unterminated string/)
        expect(msg('a == 1 b == 2')).toMatch(/expected AND, OR/)
        expect(msg('a ! 1')).toMatch(/Unexpected character "!"/)
        expect(msg('a in 1')).toMatch(/expected "\["/)
    })

    it('invalid regex is reported at compile time', () => {
        expect(() => compileQueryString('a matches "("')).toThrow(/Invalid regular expression/)
    })
})

describe('properties', () => {
    const reserved = ['and', 'or', 'not', 'in', 'exists', 'contains', 'matches', 'true', 'false', 'null']
    // Root fields (id, type, timestamp, ...) read the event itself, not the payload, so payload properties must avoid them.
    const rootFields = ['id', 'type', 'timestamp', 'parsedtype', 'streamid', 'streamcolor', 'arrivaltime']
    const ident = fc.stringMatching(/^[a-z][a-z0-9_]{0,8}$/).filter((s) => !reserved.includes(s) && !rootFields.includes(s))

    it('never throws anything but QueryParseError for arbitrary input', () => {
        fc.assert(fc.property(fc.string(), (q) => {
            try { compileQueryString(q) } catch (e) { return e instanceof QueryParseError }
            return true
        }), { numRuns: 500 })
    })

    it('numeric comparisons agree with JavaScript for any integer pair', () => {
        fc.assert(fc.property(ident, fc.integer({ min: -1e6, max: 1e6 }), fc.integer({ min: -1e6, max: 1e6 }), (f, a, b) => {
            const e = ev({ [f]: a })
            return compileQueryString(`${f} > ${b}`)(e) === (a > b)
                && compileQueryString(`${f} >= ${b}`)(e) === (a >= b)
                && compileQueryString(`${f} < ${b}`)(e) === (a < b)
                && compileQueryString(`${f} <= ${b}`)(e) === (a <= b)
                && compileQueryString(`${f} == ${b}`)(e) === (a === b)
        }), { numRuns: 300 })
    })

    it('a JSON-quoted string always matches the value it was made from', () => {
        fc.assert(fc.property(ident, fc.string({ maxLength: 20 }), (f, s) => {
            return compileQueryString(`${f} == ${JSON.stringify(s)}`)(ev({ [f]: s })) === true
        }), { numRuns: 300 })
    })

    it('NOT is exact negation; AND/OR follow boolean algebra', () => {
        fc.assert(fc.property(fc.boolean(), fc.boolean(), (x, y) => {
            const e = ev({ x: x ? 1 : 0, y: y ? 1 : 0 })
            return compileQueryString('NOT x == 1')(e) === !x
                && compileQueryString('x == 1 AND y == 1')(e) === (x && y)
                && compileQueryString('x == 1 OR y == 1')(e) === (x || y)
        }))
    })
})
