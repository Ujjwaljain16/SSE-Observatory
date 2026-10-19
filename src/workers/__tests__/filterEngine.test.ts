import { describe, it, expect } from 'vitest'
import fc from 'fast-check'
import { FilterEngine } from '../filterEngine'
import type { EventMessage } from '../../types'

const mk = (i: number, extra: Record<string, unknown> = {}): EventMessage => ({
    id: `e${i}`,
    type: i % 3 === 0 ? 'error' : 'message',
    timestamp: `10:00:${String(i % 60).padStart(2, '0')}`,
    raw: '',
    data: JSON.stringify({ n: i, level: i % 2 ? 'error' : 'info', ...extra }),
    _searchIndex: `n ${i} level`,
})
const ids = (e: FilterEngine) => e.snapshot().map((x) => x.id)

describe('FilterEngine', () => {
    it('returns events newest first', () => {
        const e = new FilterEngine()
        e.addEvents([mk(1), mk(2), mk(3)])
        expect(ids(e)).toEqual(['e3', 'e2', 'e1'])
    })

    it('is bounded: oldest events are dropped once maxEvents is exceeded', () => {
        const e = new FilterEngine()
        e.configure(5)
        for (let i = 0; i < 100; i++) e.addEvents([mk(i)])
        expect(e.size).toBe(5)
        expect(ids(e)).toEqual(['e99', 'e98', 'e97', 'e96', 'e95'])
    })

    it('keeps updating after the buffer is full (the old "length changed" bug)', () => {
        const e = new FilterEngine()
        e.configure(3)
        e.setQuery('level == "error"', '')
        for (let i = 0; i < 12; i++) e.addEvents([mk(i)])
        // retained window is e9..e11; errors are the odd ones
        expect(ids(e)).toEqual(['e11', 'e9'])
    })

    it('trimming also drops filtered entries that fell out of the window', () => {
        const e = new FilterEngine()
        e.configure(4)
        e.setQuery('level == "error"', '')
        e.addEvents([1, 2, 3, 4, 5, 6, 7, 8].map((i) => mk(i)))
        expect(ids(e)).toEqual(['e7', 'e5']) // retained window is e5..e8
        e.configure(2) // shrinking recomputes
        expect(ids(e)).toEqual(['e7'])
    })

    it('query, search and field filters combine with AND and can change at any time', () => {
        const e = new FilterEngine()
        e.addEvents([1, 2, 3, 4, 5, 6].map((i) => mk(i)))
        e.setQuery('n > 1', '')
        expect(ids(e)).toEqual(['e6', 'e5', 'e4', 'e3', 'e2'])
        e.setCustomFilters([{ field: 'level', activeValues: ['error'], isRegex: false }])
        expect(ids(e)).toEqual(['e5', 'e3'])
        e.setQuery('n > 1', 'e5')
        expect(ids(e)).toEqual(['e5'])
        e.setCustomFilters([])
        e.setQuery('', '')
        expect(ids(e)).toHaveLength(6)
    })

    it('clear() drops events but keeps the active filters', () => {
        const e = new FilterEngine()
        e.setQuery('level == "error"', '')
        e.addEvents([mk(1), mk(2)])
        e.clear()
        expect(ids(e)).toEqual([])
        e.addEvents([mk(3), mk(4)])
        expect(ids(e)).toEqual(['e3'])
    })

    it('an invalid query degrades to substring matching instead of hiding everything', () => {
        const e = new FilterEngine()
        e.addEvents([mk(3), mk(4)])
        e.setQuery('type ==', '') // incomplete
        expect(ids(e)).toEqual([]) // no event type contains "type =="
        e.setQuery('err', '')
        expect(ids(e)).toEqual(['e3']) // type "error" contains "err"
    })

    it('handles very large payloads', () => {
        const e = new FilterEngine()
        const big = mk(1, { blob: 'x'.repeat(2_000_000) })
        e.addEvents([big, mk(2)])
        e.setQuery('blob contains "xxx"', '')
        expect(ids(e)).toEqual(['e1'])
    })

    it('property: incremental result always equals a from-scratch filter of the retained window', () => {
        fc.assert(fc.property(
            fc.integer({ min: 1, max: 20 }),
            fc.array(fc.record({ batch: fc.integer({ min: 1, max: 6 }), q: fc.constantFrom('', 'level == "error"', 'n >= 5', 'NOT level == "error"') }), { minLength: 1, maxLength: 25 }),
            (cap, ops) => {
                const engine = new FilterEngine()
                engine.configure(cap)
                const all: EventMessage[] = []
                let query = ''
                let counter = 0
                for (const op of ops) {
                    if (op.q !== query) { query = op.q; engine.setQuery(query, '') }
                    const batch = Array.from({ length: op.batch }, () => mk(counter++))
                    all.push(...batch)
                    engine.addEvents(batch)
                }
                const fresh = new FilterEngine()
                fresh.configure(cap)
                fresh.setQuery(query, '')
                fresh.addEvents(all.slice(-cap))
                return JSON.stringify(ids(engine)) === JSON.stringify(ids(fresh))
            }
        ), { numRuns: 200 })
    })
})
