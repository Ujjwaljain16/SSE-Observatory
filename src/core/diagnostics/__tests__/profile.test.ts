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

describe('the display mapping', () => {
    it('reads type, summary and id paths, and trims them', () => {
        const r = parseProfile({ display: { type: ' $.object ', summary: '$.choices[0].delta.content', id: 'msg.id' } })
        expect(r).toEqual({ ok: true, profile: { display: { type: '$.object', summary: '$.choices[0].delta.content', id: 'msg.id' } } })
    })

    it('says what is wrong with each part, all at once', () => {
        const r = parseProfile({ display: { type: 5, summary: 'not a path!', nope: '$.x' } })
        expect(r.ok).toBe(false)
        if (!r.ok) {
            expect(r.errors).toHaveLength(3)
            expect(r.errors.join('\n')).toContain('"display.type" must be a JSON path')
            expect(r.errors.join('\n')).toContain('"display.summary" must be a JSON path')
            expect(r.errors.join('\n')).toContain('Unknown field "display.nope"')
        }
        const notObject = parseProfile({ display: ['$.x'] })
        expect(notObject.ok).toBe(false)
    })

    it('leaves an empty display out, and does not make the recorder read anything more', () => {
        expect(parseProfile({ display: {} })).toEqual({ ok: true, profile: {} })
        const withDisplay = { sequence: { useSseId: true as const, policy: 'consecutive' as const }, display: { summary: '$.text' } }
        expect(sameProbe(withDisplay, { sequence: withDisplay.sequence })).toBe(true) // display is read when events are drawn, so no new connection is needed
        expect(probeConfigOf(withDisplay)).toEqual(probeConfigOf({ sequence: withDisplay.sequence }))
    })

    it('says in the one-line description that a mapping is declared', () => {
        expect(describeProfile({ display: { type: '$.kind', summary: '$.text' } })).toBe('display type/summary')
    })
})

describe('the shapes switch', () => {
    it('accepts false (do not keep payload shapes), and leaves true as the default it is', () => {
        expect(parseProfile({ shapes: false })).toEqual({ ok: true, profile: { shapes: false } })
        expect(parseProfile({ shapes: true })).toEqual({ ok: true, profile: {} })
        const bad = parseProfile({ shapes: 'no' })
        expect(bad.ok).toBe(false)
        if (!bad.ok) expect(bad.errors[0]).toBe('"shapes" must be true or false.')
    })

    it('reaches the recorder, so turning it off needs a new connection', () => {
        expect(probeConfigOf({ shapes: false })).toEqual({ shape: false })
        expect(probeConfigOf({})).toEqual({})
        expect(sameProbe({ shapes: false }, {})).toBe(false)
        expect(sameProbe({ shapes: false }, { shapes: false })).toBe(true)
    })

    it('is named in the one-line description', () => {
        expect(describeProfile({ shapes: false })).toBe('payload shapes not kept')
    })
})
