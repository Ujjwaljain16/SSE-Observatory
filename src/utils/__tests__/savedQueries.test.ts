import { afterEach, describe, expect, it } from 'vitest'
import { MAX_SAVED_QUERIES, getSavedQueries, removeQuery, saveQuery } from '../savedQueries'

afterEach(() => localStorage.clear())

describe('saved queries', () => {
    it('keeps a filter under a name, newest first', () => {
        saveQuery('errors', 'type == "error"')
        saveQuery('big', 'data.value > 50')
        expect(getSavedQueries()).toEqual([{ name: 'big', query: 'data.value > 50' }, { name: 'errors', query: 'type == "error"' }])
    })

    it('uses the filter as its name when none is given, and replaces a name that is saved again', () => {
        saveQuery('', 'type == "a"')
        expect(getSavedQueries()[0]).toEqual({ name: 'type == "a"', query: 'type == "a"' })
        saveQuery('x', 'one')
        saveQuery('x', 'two')
        expect(getSavedQueries().filter((q) => q.name === 'x')).toEqual([{ name: 'x', query: 'two' }])
    })

    it('does not save an empty filter, and can remove one', () => {
        saveQuery('nothing', '   ')
        expect(getSavedQueries()).toEqual([])
        saveQuery('a', 'x')
        expect(removeQuery('a')).toEqual([])
    })

    it('is bounded, and ignores stored text that is not a list of filters', () => {
        for (let i = 0; i < MAX_SAVED_QUERIES + 10; i++) saveQuery(`q${i}`, `type == "${i}"`)
        expect(getSavedQueries()).toHaveLength(MAX_SAVED_QUERIES)
        localStorage.setItem('sse.savedQueries', '{"not":"a list"}')
        expect(getSavedQueries()).toEqual([])
        localStorage.setItem('sse.savedQueries', '[1,"x",{"name":"ok","query":"y"},{"name":5}]')
        expect(getSavedQueries()).toEqual([{ name: 'ok', query: 'y' }])
        localStorage.setItem('sse.savedQueries', 'not json')
        expect(getSavedQueries()).toEqual([])
    })

    it('shortens very long names and filters', () => {
        saveQuery('n'.repeat(500), 'q'.repeat(2000))
        const [q] = getSavedQueries()
        expect(q!.name).toHaveLength(60)
        expect(q!.query).toHaveLength(500)
    })
})
