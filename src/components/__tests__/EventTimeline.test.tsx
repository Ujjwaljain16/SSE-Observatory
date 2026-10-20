import { StrictMode } from 'react'
import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, fireEvent, screen } from '@testing-library/react'
import { EventTimeline } from '../EventTimeline'
import { typeCode, colorFor, barHeightFraction, TYPE_ERROR, TYPE_PING, TYPE_UPDATE, TYPE_DEFAULT } from '../../utils/timelinePalette'
import type { EventMessage } from '../../types'

const makeEvents = (n: number): EventMessage[] =>
    Array.from({ length: n }, (_, i) => ({
        id: `e${n - 1 - i}`, type: i === 0 ? 'error' : 'message', timestamp: `10:00:0${i}`, data: '{}', raw: '{}', arrivalTime: 1000 + (n - i) * 100,
    }))

afterEach(() => vi.restoreAllMocks())

describe('EventTimeline', () => {
    it('creates its own canvas inside the slider', () => {
        const { container } = render(<EventTimeline theme="dark" events={makeEvents(5)} currentEventIndex={0} onSeek={vi.fn()} />)
        expect(screen.getByRole('slider', { name: 'Event timeline' })).toBeInTheDocument()
        expect(container.querySelectorAll('canvas')).toHaveLength(1)
    })

    it('survives StrictMode double-mounting with exactly one live canvas (no transferred-canvas errors)', () => {
        const { container, unmount } = render(
            <StrictMode><EventTimeline theme="dark" events={makeEvents(5)} currentEventIndex={0} onSeek={vi.fn()} /></StrictMode>
        )
        expect(container.querySelectorAll('canvas')).toHaveLength(1)
        unmount()
        expect(document.querySelectorAll('canvas')).toHaveLength(0)
    })

    it('renders with no events and exposes the playhead to assistive tech', () => {
        render(<EventTimeline theme="light" events={[]} currentEventIndex={0} onSeek={vi.fn()} />)
        const slider = screen.getByRole('slider')
        expect(slider).toHaveAttribute('aria-valuemax', '0')
    })

    it('hover + click seeks to the event under the pointer (newest on the right)', () => {
        vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue({ left: 0, top: 0, right: 100, bottom: 64, width: 100, height: 64, x: 0, y: 0, toJSON: () => ({}) })
        const onSeek = vi.fn()
        render(<EventTimeline theme="dark" events={makeEvents(10)} currentEventIndex={0} onSeek={onSeek} />)
        const slider = screen.getByRole('slider')

        fireEvent.mouseMove(slider, { clientX: 99 })
        fireEvent.click(slider)
        expect(onSeek).toHaveBeenLastCalledWith(0) // far right = newest = index 0

        fireEvent.mouseMove(slider, { clientX: 1 })
        fireEvent.click(slider)
        expect(onSeek).toHaveBeenLastCalledWith(9) // far left = oldest
    })

    it('shows a tooltip for the hovered event and hides it on leave', () => {
        vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue({ left: 0, top: 0, right: 100, bottom: 64, width: 100, height: 64, x: 0, y: 0, toJSON: () => ({}) })
        render(<EventTimeline theme="dark" events={makeEvents(10)} currentEventIndex={0} onSeek={vi.fn()} />)
        const slider = screen.getByRole('slider')
        fireEvent.mouseMove(slider, { clientX: 99 })
        expect(screen.getByText('error')).toBeInTheDocument()
        fireEvent.mouseLeave(slider)
        expect(screen.queryByText('error')).not.toBeInTheDocument()
    })
})

describe('timeline palette (shared by worker and fallback)', () => {
    it('classifies events by SSE event name or JSON type', () => {
        expect(typeCode({ type: 'error' })).toBe(TYPE_ERROR)
        expect(typeCode({ type: 'message', parsedType: 'error' })).toBe(TYPE_ERROR)
        expect(typeCode({ type: 'ping' })).toBe(TYPE_PING)
        expect(typeCode({ type: 'message', parsedType: 'update' })).toBe(TYPE_UPDATE)
        expect(typeCode({ type: 'update' })).toBe(TYPE_UPDATE)
        expect(typeCode({ type: 'message' })).toBe(TYPE_DEFAULT)
    })
    it('has distinct colours per class and theme, and taller bars for errors and the playhead', () => {
        const codes = [TYPE_DEFAULT, TYPE_ERROR, TYPE_PING, TYPE_UPDATE]
        expect(new Set(codes.map((c) => colorFor(c, true))).size).toBe(4)
        expect(colorFor(TYPE_ERROR, true)).not.toBe(colorFor(TYPE_ERROR, false))
        expect(colorFor(TYPE_DEFAULT, true, true)).not.toBe(colorFor(TYPE_DEFAULT, true))
        expect(barHeightFraction(TYPE_ERROR, false)).toBeGreaterThan(barHeightFraction(TYPE_DEFAULT, false))
        expect(barHeightFraction(TYPE_DEFAULT, true)).toBeGreaterThan(barHeightFraction(TYPE_ERROR, false))
    })
})
