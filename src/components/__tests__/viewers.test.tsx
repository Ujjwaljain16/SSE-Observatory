import { render, screen, renderHook, act, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { HighlightedJson, JsonTree } from '../JsonViewer'
import { TypeChart } from '../TypeChart'
import RequestView from '../doctor/RequestView'
import TimelineView from '../doctor/TimelineView'
import { useEventRate } from '../../hooks/useEventRate'
import { observationRegistry } from '../../doctor/observationRegistry'
import { capture } from '../../core/testing/captureBuilder'
import type { DoctorView } from '../../doctor/doctorSession'
import type { EventMessage } from '../../types'
import { MAX_HIGHLIGHT_CHARS } from '../../utils/jsonView'

afterEach(() => { vi.useRealTimers() })

const ev = (over: Partial<EventMessage> = {}): EventMessage => ({ id: Math.random().toString(36), timestamp: '', type: 'message', data: '{}', raw: '', arrivalTime: Date.now(), ...over })

describe('HighlightedJson', () => {
    const text = '{\n  "a": 1,\n  "b": "x",\n  "c": [true, null]\n}'

    it('shows exactly the text it was given, with the parts in separate coloured spans', () => {
        const { container } = render(<HighlightedJson text={text} theme="dark" />)
        expect(container.textContent).toBe(text)
        expect(container.querySelectorAll('span.text-sky-300')).toHaveLength(3) // the three keys
        expect(container.querySelectorAll('span.text-emerald-300')).toHaveLength(1) // "x"
        expect(container.querySelectorAll('span.text-amber-300')).toHaveLength(1) // 1
        expect(container.querySelectorAll('span.text-violet-300')).toHaveLength(2) // true, null
    })

    it('uses its own colours in the light theme', () => {
        const { container } = render(<HighlightedJson text={text} theme="light" />)
        expect(container.querySelectorAll('span.text-sky-800')).toHaveLength(3)
        expect(container.querySelectorAll('span.text-sky-300')).toHaveLength(0)
    })

    it('shows a long payload as plain text, unchanged', () => {
        const long = `{"a":"${'x'.repeat(MAX_HIGHLIGHT_CHARS)}"}`
        const { container } = render(<HighlightedJson text={long} theme="dark" />)
        expect(container.textContent).toBe(long)
        expect(container.querySelectorAll('pre > span')).toHaveLength(1)
    })
})

describe('JsonTree', () => {
    const value = { user: { name: 'ada', tags: ['a', 'b'] }, ok: true, none: null }

    it('opens the first two levels and leaves deeper ones closed', () => {
        render(<JsonTree value={value} theme="dark" />)
        expect(screen.getByRole('button', { name: /\{3 keys\}/ })).toHaveAttribute('aria-expanded', 'true')
        expect(screen.getByRole('button', { name: /user/ })).toHaveAttribute('aria-expanded', 'true')
        expect(screen.getByRole('button', { name: /tags/ })).toHaveAttribute('aria-expanded', 'false')
        expect(screen.getByText('"ada"')).toBeInTheDocument()
        expect(screen.queryByText('"a"')).toBeNull() // inside the closed tags list
    })

    it('folds and opens a node on click', async () => {
        render(<JsonTree value={value} theme="light" />)
        const user = screen.getByRole('button', { name: /user/ })
        await userEvent.click(user)
        expect(user).toHaveAttribute('aria-expanded', 'false')
        expect(screen.queryByText('"ada"')).toBeNull()
        await userEvent.click(user)
        expect(screen.getByText('"ada"')).toBeInTheDocument()
        await userEvent.click(screen.getByRole('button', { name: /tags/ }))
        expect(screen.getByText('"a"')).toBeInTheDocument()
    })

    it('shows a long list a hundred at a time', async () => {
        render(<JsonTree value={{ items: Array.from({ length: 250 }, (_, i) => i) }} theme="dark" />)
        const items = screen.getByRole('button', { name: /items/ })
        await userEvent.click(items) // depth 1 is open, so this closes it
        await userEvent.click(items)
        expect(screen.getByRole('button', { name: /Show 100 more of 150 not shown/ })).toBeInTheDocument()
        await userEvent.click(screen.getByRole('button', { name: /Show 100 more/ }))
        expect(screen.getByRole('button', { name: /Show 50 more of 50 not shown/ })).toBeInTheDocument()
    })

    it('writes leaves as JSON, including a number and null', () => {
        render(<JsonTree value={{ n: 5, z: null, s: 'a"b' }} theme="dark" />)
        expect(screen.getByText('5')).toBeInTheDocument()
        expect(screen.getByText('null')).toBeInTheDocument()
        expect(screen.getByText('"a\\"b"')).toBeInTheDocument()
    })
})

describe('TypeChart', () => {
    it('lists each type with its count and share written out', () => {
        render(<TypeChart theme="dark" events={[ev({ type: 'ping' }), ev({ type: 'ping' }), ev({ type: 'ping' }), ev({ type: 'update', parsedType: 'tick' })]} />)
        const rows = screen.getAllByTestId('type-row')
        expect(rows).toHaveLength(2)
        expect(rows[0]).toHaveTextContent('ping')
        expect(rows[0]).toHaveTextContent('3 (75%)')
        expect(rows[1]).toHaveTextContent('tick') // the type a person sees
        expect(rows[1]).toHaveTextContent('1 (25%)')
    })

    it('shows nothing with no events, and folds a long tail into other', () => {
        const { container, rerender } = render(<TypeChart theme="light" events={[]} />)
        expect(container).toBeEmptyDOMElement()
        rerender(<TypeChart theme="light" events={Array.from({ length: 12 }, (_, i) => ev({ type: `t${i}` }))} />)
        expect(screen.getAllByTestId('type-row')).toHaveLength(9)
        expect(screen.getByText('other')).toBeInTheDocument()
    })
})

describe('useEventRate', () => {
    it('updates once a second, falls to zero when events stop, and stops when inactive', () => {
        vi.useFakeTimers({ now: 1_000_000 })
        const events = Array.from({ length: 20 }, (_, i) => ev({ arrivalTime: 1_000_000 - i * 100 })) // 20 events in the last 1.9 s
        const { result, rerender } = renderHook(({ active }) => useEventRate(events, active), { initialProps: { active: true } })
        expect(result.current).toBeGreaterThan(5)
        act(() => { vi.advanceTimersByTime(30_000) })
        expect(result.current).toBe(0) // nothing arrived in the last five seconds
        rerender({ active: false })
        expect(result.current).toBe(0)
    })
})

describe('RequestView', () => {
    const view = (records: number, nowT = 2000) => ({ health: { capture: { records } }, nowT }) as unknown as DoctorView

    it('says nothing has been recorded when the stream has no records', () => {
        render(<RequestView theme="dark" streamId="no-such-stream" view={view(0)} />)
        expect(screen.getByTestId('doctor-request')).toHaveTextContent('Nothing recorded yet')
    })

    it('shows the request, the response, the kept headers and the timing of each attempt, newest first', () => {
        const b = capture().at(100).connect({ url: 'http://stream.test/events', headerNames: ['accept'] })
        b.silence(40).response({ headers: { via: '1.1 edge' } })
        b.silence(60).frame('tick', '1')
        b.phase('reconnecting', { attempt: 1, delayMs: 500, reason: 'Stream closed by server' })
        b.silence(500).connect({ sentLastEventId: '1' }).response({ status: 503, contentType: 'text/html' })
        observationRegistry.receive('req-view', { captureId: 'c1', batch: b.observations() })
        render(<RequestView theme="light" streamId="req-view" view={view(b.observations().length)} />)

        const attempts = screen.getAllByTestId('request-attempt')
        expect(attempts).toHaveLength(2)
        expect(attempts[0]).toHaveTextContent('Connection 2 (retry 1): 503 (not a success)') // newest first
        expect(attempts[1]).toHaveTextContent('Connection 1 (retry 0): 200')
        const first = attempts[1]!
        expect(first).toHaveTextContent('GET http://stream.test/events')
        expect(first).toHaveTextContent('Header names sent: accept')
        expect(first).toHaveTextContent('Last-Event-ID: none (first connection)')
        expect(first).toHaveTextContent('via')
        expect(first).toHaveTextContent('1.1 edge')
        expect(first).toHaveTextContent('First event')
        expect(attempts[0]).toHaveTextContent('Last-Event-ID: 1')
        expect(screen.queryByTestId('request-proxy-note')).toBeNull()
    })

    it('says when an attempt got no response, and when the request went through the app proxy', () => {
        const b = capture().connect({ url: 'http://localhost:3001/api/sse', method: 'POST' })
        b.silence(3000).phase('failed', { attempt: 0, reason: 'connection refused' })
        observationRegistry.receive('req-proxy', { captureId: 'c2', batch: b.observations() })
        render(<RequestView theme="dark" streamId="req-proxy" view={view(b.observations().length, 4000)} sectionHeading="h4" />)
        expect(screen.getByText('No response arrived on this attempt.')).toBeInTheDocument()
        expect(screen.getByTestId('request-proxy-note')).toHaveTextContent("the app's server proxy")
        expect(screen.getAllByRole('heading', { level: 4 }).length).toBeGreaterThan(0)
    })
})

describe('TimelineView', () => {
    const view = (records: number, nowT = 2000) => ({ health: { capture: { records } }, nowT, captureId: 'timeline-c' }) as unknown as DoctorView

    // Q18: after a connection that opened the client's retry counter restarts, so rows 2, 3 and 4 of f05-drops all carry retry 1.
    it('labels the rows by connection (1, 2, 3, 4) and shows the retry counter in its own column', () => {
        const b = capture().connect().response().frame('tick', '3')
        for (const last of ['3', '6', '9']) b.reconnect({ attempt: 1, delayMs: 100, lastEventIdSent: last }).silence(100).connect({ sentLastEventId: last }).response().frame('tick', String(Number(last) + 3))
        const records = b.observations().map((r) => (r.kind === 'connect' ? { ...r, attempt: Math.min(r.conn, 1) } : r)) // the counter reads 0, 1, 1, 1
        observationRegistry.receive('timeline-view', { captureId: 'timeline-c', batch: records })
        render(<TimelineView theme="light" streamId="timeline-view" view={view(records.length)} />)

        const table = screen.getByTestId('timeline-table')
        const headers = within(table).getAllByRole('columnheader').map((h) => h.textContent)
        expect(headers.slice(0, 2)).toEqual(['Connection', 'Retry'])
        expect(headers).not.toContain('Attempt')
        const rows = within(table).getAllByRole('row').slice(1)
        expect(rows.map((r) => within(r).getByRole('rowheader').textContent)).toEqual(['#1', '#2', '#3', '#4'])
        expect(screen.getAllByTestId('timeline-retry').map((c) => c.textContent)).toEqual(['0', '1', '1', '1'])
        expect(screen.getByRole('img', { name: /Timeline of 4 connection attempts/ })).toBeInTheDocument()
    })
})
