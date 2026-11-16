import { render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { EventsList } from '../EventsList'
import type { EventMessage } from '../../types'

const ev = (n: number): EventMessage => ({ id: `e${n}`, type: 'message', timestamp: 't', raw: `data: ${n}`, data: String(n), arrivalTime: n })
const events = (n: number) => Array.from({ length: n }, (_, i) => ev(n - i))

const show = (filtered: number, extra: { totalReceived?: number; bufferedCount?: number } = {}) =>
    render(
        <EventsList
            theme="light" connected={false} filteredEvents={events(filtered)} customFilters={[]} copiedId={null} isLive={true}
            onCopyToClipboard={vi.fn()} {...extra}
        />,
    )

// jsdom has no layout: the list only needs these not to throw
beforeEach(() => { localStorage.clear(); Element.prototype.scrollTo = vi.fn() as never })

describe('the event list header counts', () => {
    it('says how many events were captured when nothing has been pushed out of the buffer', () => {
        show(3, { totalReceived: 3, bufferedCount: 3 })
        expect(screen.getByTestId('event-count')).toHaveTextContent(/^3 events captured$/)
    })

    it('does the same when the caller does not know the total (the multi-stream list)', () => {
        show(3)
        expect(screen.getByTestId('event-count')).toHaveTextContent(/^3 events captured$/)
    })

    it('says "newest N of M" when the buffer is capped and the list shows all of it', () => {
        show(3, { totalReceived: 1225, bufferedCount: 3 })
        expect(screen.getByTestId('event-count')).toHaveTextContent(/^newest 3 of 1,225 events$/)
    })

    it('writes thousands with a separator, as the Doctor does', () => {
        show(2, { totalReceived: 1_234_567, bufferedCount: 2 })
        expect(screen.getByTestId('event-count')).toHaveTextContent('newest 2 of 1,234,567 events')
    })

    it('says what a filter leaves of the capped buffer, and what the total is', () => {
        show(2, { totalReceived: 50, bufferedCount: 10 })
        expect(screen.getByTestId('event-count')).toHaveTextContent(/^2 of the newest 10 events \(50 received\)$/)
    })

    it('is not capped when the viewer holds history loaded from storage (fewer received than shown)', () => {
        show(5, { totalReceived: 0, bufferedCount: 5 })
        expect(screen.getByTestId('event-count')).toHaveTextContent(/^5 events captured$/)
    })

    it('is not capped when exactly as many were received as are held', () => {
        show(4, { totalReceived: 4, bufferedCount: 4 })
        expect(screen.getByTestId('event-count')).toHaveTextContent(/^4 events captured$/)
    })
})
