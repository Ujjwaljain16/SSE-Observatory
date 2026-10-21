import { describe, expect, it } from 'vitest'
import { describeProfile, parseProfile, probeConfigOf, sameProbe } from '../profile'

const ok = (value: unknown) => {
    const r = parseProfile(value)
    if (!r.ok) throw new Error(r.errors.join('; '))
    return r.profile
}
const errors = (value: unknown) => {
    const r = parseProfile(value)
    return r.ok ? [] : r.errors
}

describe('parseProfile', () => {
    it('accepts a full profile and returns it unchanged', () => {
        const p = { sequence: { field: '$.seq', policy: 'consecutive', partitionBy: '$event' }, delivery: 'at_least_once', timestampField: '$.ts', expected: { firstEventMs: 2000, maxSilenceMs: 20000, heartbeatMs: 15000 } }
        expect(ok(p)).toEqual(p)
    })

    it('accepts the SSE id as the sequence, and an empty profile', () => {
        expect(ok({ sequence: { useSseId: true, policy: 'monotonic' } }).sequence).toEqual({ useSseId: true, policy: 'monotonic' })
        expect(ok({})).toEqual({})
    })

    it('ignores a $schema line, so an editor-completed file works', () => {
        expect(ok({ $schema: 'https://example.test/s.json', delivery: 'exactly_once' })).toEqual({ delivery: 'exactly_once' })
    })

    it.each([
        [null, /JSON object/], [[], /JSON object/], ['x', /JSON object/],
        [{ seqeunce: {} }, /Unknown field "seqeunce"/],
        [{ sequence: { policy: 'consecutive' } }, /needs a "field" or "useSseId"/],
        [{ sequence: { field: '$.seq' } }, /policy/],
        [{ sequence: { field: '$.seq', useSseId: true, policy: 'consecutive' } }, /not both/],
        [{ sequence: { field: '$.a b', policy: 'consecutive' } }, /JSON path/],
        [{ sequence: { field: '$.seq', policy: 'consecutive', partitionBy: 'no spaces allowed' } }, /partitionBy/],
        [{ sequence: { field: '$.seq', policy: 'consecutive', extra: 1 } }, /Unknown field "sequence.extra"/],
        [{ delivery: 'sometimes' }, /at_least_once/],
        [{ timestampField: 5 }, /timestampField/],
        [{ expected: { maxSilenceMs: -1 } }, /above 0/],
        [{ expected: { soon: 5 } }, /Unknown field "expected.soon"/],
    ])('refuses %j with a plain message', (value, message) => {
        expect(errors(value).join(' ')).toMatch(message)
    })

    it('reports every problem at once, not just the first', () => {
        expect(errors({ delivery: 'x', timestampField: 3, bogus: 1 }).length).toBe(3)
    })

    it('does not follow prototype paths: a path is only text here', () => {
        expect(ok({ timestampField: '$.__proto__' })).toEqual({ timestampField: '$.__proto__' }) // allowed as text; the reader never follows it (see jsonPath)
    })
})

describe('probeConfigOf', () => {
    it('keeps only what the recorder needs from payloads', () => {
        expect(probeConfigOf({ sequence: { field: '$.seq', policy: 'consecutive', partitionBy: '$.shard' }, timestampField: '$.ts', delivery: 'exactly_once', expected: { maxSilenceMs: 1 } }))
            .toEqual({ sequence: { field: '$.seq' }, partitionBy: '$.shard', timestampField: '$.ts' })
        expect(probeConfigOf(undefined)).toEqual({})
        expect(probeConfigOf({ delivery: 'at_least_once' })).toEqual({})
    })

    it('two profiles differing only in what is read at analysis time need no new connection', () => {
        const a = { sequence: { field: '$.seq', policy: 'consecutive' as const } }
        expect(sameProbe(a, { ...a, sequence: { ...a.sequence, policy: 'monotonic' as const }, delivery: 'exactly_once' as const })).toBe(true)
        expect(sameProbe(a, { sequence: { field: '$.n', policy: 'consecutive' as const } })).toBe(false)
        expect(sameProbe(a, undefined)).toBe(false)
    })
})

describe('describeProfile', () => {
    it('says in a line what is declared', () => {
        expect(describeProfile(undefined)).toBe('no profile')
        expect(describeProfile({})).toBe('empty profile')
        expect(describeProfile({ sequence: { field: '$.seq', policy: 'consecutive', partitionBy: '$event' }, delivery: 'at_least_once' })).toBe('sequence $.seq (consecutive, per $event), at least once')
        expect(describeProfile({ sequence: { useSseId: true, policy: 'monotonic' } })).toBe('sequence in the SSE id (monotonic)')
    })
})
