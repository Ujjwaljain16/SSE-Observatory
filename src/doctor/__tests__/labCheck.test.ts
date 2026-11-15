import { describe, expect, it } from 'vitest'
import { checkExpectations, matchesKey } from '../labCheck'

describe('matchesKey', () => {
    it('matches the key itself and any key that continues it', () => {
        expect(matchesKey('stall.silent:events', 'stall.silent')).toBe(true)
        expect(matchesKey('stall.silent', 'stall.silent')).toBe(true)
        expect(matchesKey('stall.silent:events', 'stall.silent:events')).toBe(true)
        expect(matchesKey('stall', 'stall.silent')).toBe(false)
        expect(matchesKey('proto.framing:BOM', 'http.status')).toBe(false)
    })
})

describe('checkExpectations', () => {
    it('is ok when everything expected was found and nothing forbidden was', () => {
        const c = checkExpectations(['stall.silent:events', 'heartbeat.absent'], ['stall.silent'], ['seq.integrity'])
        expect(c.ok).toBe(true)
        expect(c.expected).toEqual([{ key: 'stall.silent', met: true, offenders: [] }])
        expect(c.forbidden).toEqual([{ key: 'seq.integrity', met: true, offenders: [] }])
        expect(c.problems).toEqual([])
    })

    it('says what was expected but not found, and what the Doctor found instead', () => {
        const c = checkExpectations(['timing.first-event:first-event'], ['stall.silent:bytes'], [])
        expect(c.ok).toBe(false)
        expect(c.expected[0]!.met).toBe(false)
        expect(c.problems).toEqual(['stall.silent:bytes was expected but not found (found: timing.first-event:first-event)'])
    })

    it('says "found: nothing" when there were no findings at all', () => {
        expect(checkExpectations([], ['x.y'], []).problems[0]).toContain('found: nothing')
    })

    it('lists the findings that broke a "must not", and treats * as "no finding at all"', () => {
        const c = checkExpectations(['seq.integrity:gap', 'heartbeat.absent'], [], ['seq.integrity'])
        expect(c.forbidden[0]).toEqual({ key: 'seq.integrity', met: false, offenders: ['seq.integrity:gap'] })
        const healthy = checkExpectations(['heartbeat.absent'], [], ['*'])
        expect(healthy.ok).toBe(false)
        expect(healthy.problems[0]).toBe('no finding was expected to be absent but heartbeat.absent appeared')
        expect(checkExpectations([], [], ['*']).ok).toBe(true)
    })
})
