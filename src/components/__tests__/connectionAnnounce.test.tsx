import { render, screen, within } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { ConnectionPanel } from '../ConnectionPanel'
import { StreamLaneManager } from '../StreamLaneManager'
import type { StreamInstance } from '../../hooks/useMultiStream'

// What a screen reader is told about the connection (WCAG 4.1.3, status messages): a failure that ends the attempt is an alert; a
// retry is a polite status that is announced once per attempt, not on every change of the countdown.

const FAILED = 'HTTP 403 – Target resolves to a private or reserved address'
const retry = (secs: number, attempt: number) => `Connection lost (HTTP 502 Bad Gateway). Retrying in ${secs}s (attempt ${attempt})…`

type Props = Parameters<typeof ConnectionPanel>[0]
const panelProps = (over: Partial<Props> = {}): Props => ({
    theme: 'light', url: 'https://x.test/sse', bearerToken: '', profileName: '', connected: false, reconnecting: false, isLoading: false,
    error: '', connectedAt: null, eventsLength: 0,
    onUrlChange: vi.fn(), onTokenChange: vi.fn(), onProfileNameChange: vi.fn(), onSaveProfile: vi.fn(), onConnect: vi.fn(), onDisconnect: vi.fn(),
    onClearEvents: vi.fn(), useProxy: true, onProxyToggle: vi.fn(), ...over,
})

/** The text a screen reader reads from an element: what is not hidden from assistive technology. */
const spoken = (el: HTMLElement): string => {
    const walk = (node: Node): string => {
        if (node.nodeType === Node.TEXT_NODE) return node.textContent ?? ''
        if (!(node instanceof HTMLElement) || node.getAttribute('aria-hidden') === 'true') return ''
        return Array.from(node.childNodes).map(walk).join('')
    }
    return walk(el).replace(/\s+/g, ' ').trim()
}

describe('ConnectionPanel: what is announced', () => {
    it('announces a failed connect as an alert, once, with the message', () => {
        render(<ConnectionPanel {...panelProps({ error: FAILED })} />)
        const alert = screen.getByRole('alert')
        expect(alert).toHaveTextContent(FAILED)
        expect(screen.getAllByRole('alert')).toHaveLength(1)
        expect(alert).toHaveAttribute('data-testid', 'connection-error')
        // the polite status region is not repeating it
        expect(screen.getByTestId('connection-status')).not.toHaveTextContent('HTTP 403')
    })

    it('announces a retry politely, as a status and not as an alert', () => {
        render(<ConnectionPanel {...panelProps({ error: retry(5, 1), reconnecting: true })} />)
        expect(screen.queryByRole('alert')).toBeNull()
        const status = screen.getByTestId('connection-status')
        expect(status).toHaveAttribute('role', 'status')
        expect(status).toHaveAttribute('aria-live', 'polite')
        expect(status).toHaveTextContent('Connection lost (HTTP 502 Bad Gateway). Retrying in 5s (attempt 1)…') // sighted users still see the seconds
    })

    it('keeps what a screen reader reads the same while the seconds change within an attempt, and changes it for the next attempt', () => {
        const { rerender } = render(<ConnectionPanel {...panelProps({ error: retry(5, 2), reconnecting: true })} />)
        const status = screen.getByTestId('connection-status')
        const first = spoken(status)
        expect(first).toBe('Connection lost (HTTP 502 Bad Gateway). Retrying (attempt 2)…')
        for (const secs of [4, 3, 2, 1]) {
            rerender(<ConnectionPanel {...panelProps({ error: retry(secs, 2), reconnecting: true })} />)
            expect(spoken(screen.getByTestId('connection-status'))).toBe(first)
            expect(screen.getByTestId('connection-status')).toHaveTextContent(`Retrying in ${secs}s (attempt 2)`) // the visible text still counts
        }
        rerender(<ConnectionPanel {...panelProps({ error: retry(10, 3), reconnecting: true })} />)
        expect(spoken(screen.getByTestId('connection-status'))).toBe('Connection lost (HTTP 502 Bad Gateway). Retrying (attempt 3)…')
    })

    it('uses one live region through the whole life of a connection, so a change in it is announced rather than a new element appearing', () => {
        const { rerender } = render(<ConnectionPanel {...panelProps()} />)
        const status = screen.getByTestId('connection-status')
        expect(status).toHaveTextContent('Disconnected')
        rerender(<ConnectionPanel {...panelProps({ isLoading: true })} />)
        expect(screen.getByTestId('connection-status')).toBe(status)
        expect(status).toHaveTextContent('Connecting...')
        rerender(<ConnectionPanel {...panelProps({ connected: true, connectedAt: 1 })} />)
        expect(screen.getByTestId('connection-status')).toBe(status)
        expect(status).toHaveTextContent('Connected to x.test')
        rerender(<ConnectionPanel {...panelProps({ error: retry(5, 1), reconnecting: true })} />)
        expect(screen.getByTestId('connection-status')).toBe(status)
        expect(status).toHaveTextContent('Retrying')
    })

    it('says nothing alarming when all is well, and clears the alert when the person tries again', () => {
        const { rerender } = render(<ConnectionPanel {...panelProps({ error: FAILED })} />)
        expect(screen.getByRole('alert')).toBeInTheDocument()
        rerender(<ConnectionPanel {...panelProps({ isLoading: true })} />)
        expect(screen.queryByRole('alert')).toBeNull()
        expect(screen.getByTestId('connection-status')).toHaveTextContent('Connecting...')
        rerender(<ConnectionPanel {...panelProps({ connected: true, connectedAt: 1 })} />)
        expect(screen.queryByRole('alert')).toBeNull()
    })

    it('still shows the plain states for the existing tests (data-testid connection-status)', () => {
        render(<ConnectionPanel {...panelProps()} />)
        expect(screen.getByTestId('connection-status')).toHaveTextContent('Disconnected')
    })
})

describe('StreamLaneManager: what is announced', () => {
    const lane = (over: Partial<StreamInstance> = {}): StreamInstance => ({ id: 'a', name: 'orders', url: 'https://x.test/s', color: '#0af', events: [], connected: false, isLoading: false, error: '', ...over })
    const show = (streams: StreamInstance[]) =>
        render(<StreamLaneManager theme="light" streams={streams} onAddStream={vi.fn(() => 'id')} onRemoveStream={vi.fn()} onConnectStream={vi.fn()} onDisconnectStream={vi.fn()} onClearStreamEvents={vi.fn()} />)

    it('announces a lane that failed as an alert', () => {
        show([lane({ error: FAILED })])
        expect(screen.getByRole('alert')).toHaveTextContent(FAILED)
    })

    it('announces a lane that is retrying as a polite status, without the countdown', () => {
        show([lane({ error: retry(5, 4), retrying: true })])
        expect(screen.queryByRole('alert')).toBeNull()
        const status = screen.getByTestId('lane-status')
        expect(status).toHaveAttribute('role', 'status')
        expect(status).toHaveAttribute('aria-live', 'polite')
        expect(spoken(status)).toBe('Connection lost (HTTP 502 Bad Gateway). Retrying (attempt 4)…')
        expect(status).toHaveTextContent('Retrying in 5s (attempt 4)')
    })

    it('keeps the lane region mounted (and empty) while nothing is wrong, so a later retry is announced', () => {
        const { rerender } = show([lane()])
        const status = screen.getByTestId('lane-status')
        expect(status).toBeEmptyDOMElement()
        rerender(<StreamLaneManager theme="light" streams={[lane({ error: retry(5, 1), retrying: true })]} onAddStream={vi.fn(() => 'id')} onRemoveStream={vi.fn()} onConnectStream={vi.fn()} onDisconnectStream={vi.fn()} onClearStreamEvents={vi.fn()} />)
        expect(screen.getByTestId('lane-status')).toBe(status)
        expect(within(status).getByText(/Retrying/)).toBeInTheDocument()
    })

    it('does not announce a lane with no problem', () => {
        show([lane({ connected: true })])
        expect(screen.queryByRole('alert')).toBeNull()
    })
})
