import { describe, it, expect } from 'vitest'
import { getFieldValue, getParsedData } from '../eventUtils'
import type { EventMessage } from '../../types'

const ev = (data: unknown, extra: Partial<EventMessage> = {}): EventMessage =>
    ({ id: 'e1', type: 'message', timestamp: '10:00:00', raw: '', data, ...extra }) as EventMessage

describe('getFieldValue', () => {
    it('reads root fields, including numeric ones as strings', () => {
        const e = ev('{}', { parsedType: 'order', arrivalTime: 1700000000000, streamId: 's-1' })
        expect(getFieldValue(e, 'id')).toBe('e1')
        expect(getFieldValue(e, 'type')).toBe('message')
        expect(getFieldValue(e, 'parsedType')).toBe('order')
        expect(getFieldValue(e, 'arrivalTime')).toBe('1700000000000')
        expect(getFieldValue(e, 'streamId')).toBe('s-1')
        expect(getFieldValue(e, 'parsedType' + 'x')).toBeNull()
    })

    it('reads JSON string payloads with or without the data. prefix', () => {
        const e = ev('{"user":{"id":7,"tags":["a","b"]},"ok":true,"nothing":null}')
        expect(getFieldValue(e, 'data.user.id')).toBe('7')
        expect(getFieldValue(e, 'user.id')).toBe('7')
        expect(getFieldValue(e, 'user.tags.1')).toBe('b')
        expect(getFieldValue(e, 'ok')).toBe('true')
        expect(getFieldValue(e, 'nothing')).toBeNull()
        expect(getFieldValue(e, 'user.missing')).toBeNull()
        expect(getFieldValue(e, 'user.tags')).toBe('["a","b"]')
    })

    it('reads object payloads and returns the raw string for "data"', () => {
        expect(getFieldValue(ev({ a: { b: 1 } }), 'a.b')).toBe('1')
        expect(getFieldValue(ev('{"a":1}'), 'data')).toBe('{"a":1}')
    })

    it('returns null for non-JSON payloads and never reaches prototype properties', () => {
        expect(getFieldValue(ev('plain text'), 'anything')).toBeNull()
        const e = ev('{"a":1}')
        expect(getFieldValue(e, 'constructor')).toBeNull()
        expect(getFieldValue(e, '__proto__')).toBeNull()
        expect(getFieldValue(e, 'a.toString')).toBeNull()
    })
})

describe('getParsedData', () => {
    it('parses once per event object', () => {
        const e = ev('{"a":1}')
        const first = getParsedData(e)
        expect(getParsedData(e)).toBe(first)
        expect(getParsedData(ev('not json'))).toBeUndefined()
        expect(getParsedData(ev(42))).toBeUndefined()
    })
})
