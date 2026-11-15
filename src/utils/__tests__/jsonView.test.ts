import { describe, expect, it } from 'vitest'
import fc from 'fast-check'
import { childrenOf, leafText, shapeOf, summarise, tokenizeJson } from '../jsonView'

const kinds = (text: string) => tokenizeJson(text).filter((t) => t.kind !== 'space').map((t) => `${t.kind}:${t.text}`)

describe('tokenizeJson', () => {
    it('tells keys from string values, and numbers, literals and punctuation apart', () => {
        expect(kinds('{"a": 1, "b": "x", "c": [true, null, -2.5e3]}')).toEqual([
            'punct:{', 'key:"a"', 'punct::', 'number:1', 'punct:,', 'key:"b"', 'punct::', 'string:"x"', 'punct:,',
            'key:"c"', 'punct::', 'punct:[', 'literal:true', 'punct:,', 'literal:null', 'punct:,', 'number:-2.5e3', 'punct:]', 'punct:}',
        ])
    })

    it('does not take a colon inside a string for a key separator', () => {
        const t = tokenizeJson('{"a": "b: c"}')
        expect(t.filter((x) => x.kind === 'key').map((x) => x.text)).toEqual(['"a"'])
        expect(t.filter((x) => x.kind === 'string').map((x) => x.text)).toEqual(['"b: c"'])
    })

    it('handles escaped quotes inside a string', () => {
        const t = tokenizeJson('{"q": "say \\"hi\\""}')
        expect(t.find((x) => x.kind === 'string')?.text).toBe('"say \\"hi\\""')
    })

    it('keeps text it cannot classify (a truncated payload) instead of dropping it', () => {
        const text = '{\n  "a": "abc'
        expect(tokenizeJson(text).map((t) => t.text).join('')).toBe(text)
    })

    it('gives back exactly the text it was given, for any text', () => {
        fc.assert(fc.property(fc.string({ maxLength: 200 }), (s) => tokenizeJson(s).map((t) => t.text).join('') === s), { seed: 14, numRuns: 400 })
        fc.assert(fc.property(fc.jsonValue(), (v) => {
            const text = JSON.stringify(v, null, 2) ?? ''
            return tokenizeJson(text).map((t) => t.text).join('') === text
        }), { seed: 15, numRuns: 400 })
    })
})

describe('tree helpers', () => {
    it('says what a collapsed node holds', () => {
        expect(summarise({ a: 1, b: 2 })).toBe('{2 keys}')
        expect(summarise({ a: 1 })).toBe('{1 key}')
        expect(summarise([1, 2, 3])).toBe('[3 items]')
        expect(summarise([1])).toBe('[1 item]')
        expect(summarise('x')).toBeUndefined()
        expect(summarise(null)).toBeUndefined()
    })

    it('lists children in the order the payload has them, arrays by index', () => {
        expect(childrenOf({ z: 1, a: 2 })).toEqual([['z', 1], ['a', 2]])
        expect(childrenOf(['x', 'y'])).toEqual([['0', 'x'], ['1', 'y']])
        expect(childrenOf(5)).toEqual([])
    })

    it('names the shape of a value', () => {
        expect([shapeOf(null), shapeOf(undefined), shapeOf([]), shapeOf({}), shapeOf('s'), shapeOf(1), shapeOf(false)]).toEqual(['null', 'null', 'array', 'object', 'string', 'number', 'boolean'])
    })

    it('writes a leaf as JSON, and survives a value JSON cannot hold', () => {
        expect(leafText('a"b')).toBe('"a\\"b"')
        expect(leafText(undefined)).toBe('null')
        const cyclic: Record<string, unknown> = {}
        cyclic.self = cyclic
        expect(() => leafText(cyclic)).not.toThrow()
    })
})
