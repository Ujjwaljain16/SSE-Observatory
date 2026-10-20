import { describe, it, expect, vi, beforeEach } from 'vitest'

describe('filterWorker custom field filters', () => {
    let onMsg: (e: unknown) => void
    let post: ReturnType<typeof vi.fn>

    beforeEach(async () => {
        vi.resetModules()
        post = vi.fn()
        ;(globalThis as any).self = (globalThis as any).self || {}
        ;(globalThis as any).self.postMessage = post
        ;(globalThis as any).self.addEventListener = () => {}
        onMsg = (await import('../filterWorker'))._onMessage as never
    })

    const mk = (i: number) => ({
        id: `e${i}`, type: i % 3 === 0 ? 'error' : 'message', timestamp: 't', raw: '',
        data: JSON.stringify({ level: i % 2 ? 'error' : 'info', user: { id: i } }),
    })
    const lastIds = () => (post.mock.calls[post.mock.calls.length - 1][0].events as { id: string }[]).map(e => e.id).sort()

    it('filters on data.* values (payload is a JSON string)', () => {
        onMsg({ data: { type: 'ADD_EVENTS', events: [1, 2, 3, 4].map(mk) } })
        onMsg({ data: { type: 'CUSTOM_FILTERS_UPDATE', filters: [{ field: 'data.level', activeValues: ['error'], isRegex: false }] } })
        expect(lastIds()).toEqual(['e1', 'e3'])
    })

    it('supports nested paths, the no-prefix form and regex mode', () => {
        onMsg({ data: { type: 'ADD_EVENTS', events: [1, 2, 3, 4].map(mk) } })
        onMsg({ data: { type: 'CUSTOM_FILTERS_UPDATE', filters: [{ field: 'user.id', activeValues: ['2', '4'], isRegex: false }] } })
        expect(lastIds()).toEqual(['e2', 'e4'])
        onMsg({ data: { type: 'CUSTOM_FILTERS_UPDATE', filters: [{ field: 'data.level', activeValues: [], isRegex: true, regexPattern: '^ERR' }] } })
        expect(lastIds()).toEqual(['e1', 'e3'])
    })

    it('combines filters with AND and still supports root fields', () => {
        onMsg({ data: { type: 'ADD_EVENTS', events: [1, 2, 3, 4, 5, 6].map(mk) } })
        onMsg({ data: { type: 'CUSTOM_FILTERS_UPDATE', filters: [
            { field: 'type', activeValues: ['error'], isRegex: false },
            { field: 'data.level', activeValues: ['error'], isRegex: false },
        ] } })
        expect(lastIds()).toEqual(['e3']) // type=error: 3,6 ; level=error: 1,3,5
    })
})
