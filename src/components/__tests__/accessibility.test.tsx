import { render, screen, fireEvent, act } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, it, expect, vi, afterEach } from 'vitest'
import { ProfileTabs } from '../ProfileTabs'
import { TracePanel } from '../TracePanel'
import { ErrorBoundary } from '../ErrorBoundary'
import { StreamLaneManager } from '../StreamLaneManager'
import type { TraceEntry } from '../../hooks/useCorrelationTracker'
import type { EventMessage } from '../../types'

afterEach(() => { vi.useRealTimers() })

describe('ProfileTabs', () => {
    const profiles = [{ name: 'A', url: 'http://a', token: '' }, { name: 'B', url: 'http://b', token: '' }]
    const setup = (over: Partial<Parameters<typeof ProfileTabs>[0]> = {}) => {
        const props = {
            profiles, activeProfileTab: 'A', theme: 'dark' as const,
            onLoadProfile: vi.fn(), onDeleteProfile: vi.fn(), onSetActiveTab: vi.fn(), onDisconnect: vi.fn(), connected: false,
            ...over,
        }
        render(<ProfileTabs {...props} />)
        return props
    }

    it('has no button nested inside a button', () => {
        setup()
        expect(document.querySelectorAll('button button')).toHaveLength(0)
    })

    it('loads a profile on tab click and disconnects first when connected', async () => {
        const p = setup({ connected: true })
        await userEvent.click(screen.getByRole('tab', { name: 'B' }))
        expect(p.onLoadProfile).toHaveBeenCalledWith(profiles[1])
        expect(p.onDisconnect).toHaveBeenCalled()
    })

    it('needs a second click to delete, and does not load the profile', async () => {
        const p = setup()
        await userEvent.click(screen.getByRole('button', { name: 'Delete profile B' }))
        expect(p.onDeleteProfile).not.toHaveBeenCalled()
        await userEvent.click(screen.getByRole('button', { name: 'Confirm deleting profile B' }))
        expect(p.onDeleteProfile).toHaveBeenCalledWith('B')
        expect(p.onLoadProfile).not.toHaveBeenCalled()
    })

    it('forgets the pending delete after a few seconds', () => {
        vi.useFakeTimers()
        const p = setup()
        fireEvent.click(screen.getByRole('button', { name: 'Delete profile A' }))
        expect(screen.getByRole('button', { name: 'Confirm deleting profile A' })).toBeTruthy()
        act(() => { vi.advanceTimersByTime(4100) })
        expect(screen.getByRole('button', { name: 'Delete profile A' })).toBeTruthy()
        expect(p.onDeleteProfile).not.toHaveBeenCalled()
    })
})

describe('TracePanel dialog', () => {
    const ev = (id: string): EventMessage => ({ id, type: 'x', timestamp: 't', raw: '', data: '{}', arrivalTime: 1 })
    const trace: TraceEntry = { id: 'T-1', field: 'traceId', events: [ev('1'), ev('2')], firstSeen: 1, lastSeen: 2, services: ['x'] }

    it('is a labelled modal dialog that takes focus, traps Tab and closes on Escape', async () => {
        const onClose = vi.fn()
        const opener = document.createElement('button')
        document.body.appendChild(opener)
        opener.focus()
        const { unmount } = render(<TracePanel theme="dark" trace={trace} onClose={onClose} />)

        const dialog = screen.getByRole('dialog', { name: 'Trace T-1' })
        expect(dialog.getAttribute('aria-modal')).toBe('true')
        const close = screen.getByRole('button', { name: 'Close trace' })
        expect(document.activeElement).toBe(close)

        // only one focusable element: Tab and Shift+Tab stay on it
        await userEvent.tab()
        expect(document.activeElement).toBe(close)
        await userEvent.tab({ shift: true })
        expect(document.activeElement).toBe(close)

        await userEvent.keyboard('{Escape}')
        expect(onClose).toHaveBeenCalledTimes(1)

        unmount()
        expect(document.activeElement).toBe(opener) // focus returns to what opened it
        opener.remove()
    })
})

describe('ErrorBoundary', () => {
    it('shows a message with a reload button instead of a blank page', () => {
        const spy = vi.spyOn(console, 'error').mockImplementation(() => { })
        const Boom = () => { throw new Error('boom') }
        render(<ErrorBoundary><Boom /></ErrorBoundary>)
        expect(screen.getByRole('alert').textContent).toContain('An error has occurred')
        expect(screen.getByRole('button', { name: 'Reload' })).toBeTruthy()
        spy.mockRestore()
    })
})

describe('StreamLaneManager', () => {
    it('passes the optional bearer token to onAddStream and clears the form', async () => {
        const onAdd = vi.fn(() => 'id')
        render(<StreamLaneManager theme="dark" streams={[]} onAddStream={onAdd} onRemoveStream={vi.fn()} onConnectStream={vi.fn()} onDisconnectStream={vi.fn()} onClearStreamEvents={vi.fn()} />)
        await userEvent.type(screen.getByLabelText('Stream name'), 'Users')
        await userEvent.type(screen.getByLabelText('Stream URL'), 'http://x/s')
        const token = screen.getByLabelText('Bearer token (optional)') as HTMLInputElement
        expect(token.type).toBe('password')
        await userEvent.type(token, 'secret')
        await userEvent.click(screen.getByRole('button', { name: /add/i }))
        expect(onAdd).toHaveBeenCalledWith('Users', 'http://x/s', 'secret')
        expect(token.value).toBe('')
    })

    it('adds a lane without a token as undefined', async () => {
        const onAdd = vi.fn(() => 'id')
        render(<StreamLaneManager theme="dark" streams={[]} onAddStream={onAdd} onRemoveStream={vi.fn()} onConnectStream={vi.fn()} onDisconnectStream={vi.fn()} onClearStreamEvents={vi.fn()} />)
        await userEvent.type(screen.getByLabelText('Stream URL'), 'http://x/s{Enter}')
        expect(onAdd).toHaveBeenCalledWith('Stream 1', 'http://x/s', undefined)
    })
})
