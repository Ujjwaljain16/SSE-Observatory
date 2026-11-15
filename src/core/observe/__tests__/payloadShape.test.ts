// @vitest-environment node
import { describe, expect, it } from 'vitest'
import fc from 'fast-check'
import { SHAPE_MAX_CHARS, kindWord, parseShape, shapeOfText, shapeOfValue } from '../payloadShape'
import { PayloadProbe } from '../payloadProbe'

describe('shapeOfValue', () => {
    it('describes fields and their kinds, sorted, with the root first', () => {
        expect(shapeOfValue({ name: 'a', id: 1, ok: true, none: null, tags: ['x'], user: { age: 3 } }))
            .toBe('$:o|id:n|name:s|none:z|ok:b|tags:a|tags[]:s|user:o|user.age:n')
    })

    it('names an empty key, so the shape still reads back', () => {
        expect(shapeOfValue({ '': null })).toBe('$:o|_:z')
    })

    it('does not depend on the order of keys', () => {
        expect(shapeOfValue({ a: 1, b: 'x' })).toBe(shapeOfValue({ b: 'y', a: 2 }))
    })

    it('describes a list by its first element, and an empty list as a list', () => {
        expect(shapeOfValue([{ id: 1 }, { other: 2 }])).toBe('$:a|[]:o|[].id:n')
        expect(shapeOfValue({ items: [] })).toBe('$:o|items:a')
    })

    it('is undefined for anything that is not an object or a list', () => {
        for (const v of ['text', 5, true, null, undefined]) expect(shapeOfValue(v)).toBeUndefined()
    })

    it('stops at three levels and forty fields', () => {
        const deep = shapeOfValue({ a: { b: { c: { d: { e: 1 } } } } })!
        expect(deep).toContain('a.b.c:o')
        expect(deep).not.toContain('a.b.c.d')
        const wide = shapeOfValue(Object.fromEntries(Array.from({ length: 100 }, (_, i) => [`f${i}`, i])))!
        expect(wide.split('|').length).toBeLessThanOrEqual(40)
    })

    it('cuts a long key and replaces the characters that separate the parts', () => {
        const shape = shapeOfValue({ [`a|b:c.d[e]${'x'.repeat(100)}`]: 1 })!
        const key = shape.split('|')[1]!.split(':')[0]!
        expect(key.length).toBeLessThanOrEqual(32)
        expect(key).not.toMatch(/[|:.[\]]/)
        expect(parseShape(shape).size).toBe(2) // still reads back: the separators did not break it
    })

    it('holds names and kinds and never a value', () => {
        const secret = 'hunter2-canary-value'
        const shape = shapeOfValue({ user: 'ann', password: secret, nested: { token: secret }, list: [secret] })!
        expect(shape).not.toContain(secret)
        expect(shape).not.toContain('ann')
    })

    it('never throws, and always reads back into the fields it described, for any JSON', () => {
        fc.assert(fc.property(fc.jsonValue(), (v) => {
            const shape = shapeOfValue(v)
            if (shape === undefined) return true
            const fields = parseShape(shape)
            return fields.size === shape.split('|').length && fields.has('$')
        }), { seed: 14, numRuns: 500 })
    })
})

describe('shapeOfText', () => {
    it('reads JSON objects and lists, and nothing else', () => {
        expect(shapeOfText('{"a":1}')).toBe('$:o|a:n')
        expect(shapeOfText('  [1,2]')).toBe('$:a|[]:n')
        for (const text of ['', 'plain', '123', '"str"', '{ not json', 'null']) expect(shapeOfText(text), text).toBeUndefined()
    })

    it('leaves a payload over the limit alone, without parsing it', () => {
        expect(shapeOfText(`{"a":"${'x'.repeat(SHAPE_MAX_CHARS)}"}`)).toBeUndefined()
    })
})

describe('parseShape and kindWord', () => {
    it('reads a shape back, ignoring what is not a field', () => {
        expect([...parseShape('$:o|a:n|b.c:s')]).toEqual([['$', 'o'], ['a', 'n'], ['b.c', 's']])
        expect(parseShape('nonsense|:n|x:q').size).toBe(0)
        expect(parseShape('').size).toBe(0)
    })

    it('has a word for every kind', () => {
        expect((['z', 'b', 'n', 's', 'o', 'a'] as const).map(kindWord)).toEqual(['null', 'true/false', 'a number', 'text', 'an object', 'a list'])
    })
})

describe('the probe records the shape', () => {
    const input = (data: string) => ({ event: 'tick', data, id: '' })

    it('by default, for a JSON payload, next to anything the profile asks for', () => {
        const r = new PayloadProbe({ sequence: { field: '$.seq' } }, 1).probe(input('{"seq":4,"name":"a"}'))
        expect(r.extracted).toEqual({ seq: 4, shape: '$:o|name:s|seq:n' })
    })

    it('with no profile, so the drift check works without one', () => {
        expect(new PayloadProbe({}, 1).probe(input('{"a":1}')).extracted).toEqual({ shape: '$:o|a:n' })
    })

    it('not for text that is not JSON, a heartbeat, or a payload over the size limit', () => {
        const probe = new PayloadProbe({}, 1)
        expect(probe.probe(input('plain text')).extracted).toBeUndefined()
        expect(probe.probe(input('{"a":"' + 'x'.repeat(SHAPE_MAX_CHARS) + '"}')).extracted).toBeUndefined()
    })

    it('not at all when it is switched off', () => {
        expect(new PayloadProbe({ shape: false }, 1).probe(input('{"a":1}')).extracted).toBeUndefined()
    })

    it('parses the payload once when a profile field needs it too', () => {
        let parses = 0
        const original = JSON.parse
        JSON.parse = ((...args: Parameters<typeof JSON.parse>) => { parses++; return original(...args) }) as typeof JSON.parse
        try { new PayloadProbe({ sequence: { field: '$.seq' } }, 1).probe(input('{"seq":4}')) } finally { JSON.parse = original }
        expect(parses).toBe(1)
    })
})
