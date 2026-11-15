import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { FollowedFields } from '../FollowedFields'
import { TypeChart } from '../TypeChart'
import { getPins, setPins } from '../../doctor/pins'
import { typeShares } from '../../utils/eventStats'
import type { EventMessage } from '../../types'

let n = 0
const ev = (data: unknown, over: Partial<EventMessage> = {}): EventMessage => ({ id: `e${++n}`, timestamp: '', type: 'message', data: JSON.stringify(data), raw: '', arrivalTime: 0, ...over })
/** newest first, as the app keeps them */
const stream = (...payloads: unknown[]) => payloads.map((p) => ev(p)).reverse()

beforeEach(() => { localStorage.clear(); setPins([]) })

describe('FollowedFields', () => {
    const events = stream({ n: 1, status: 'ok' }, { n: 2, status: 'ok' }, { n: 3, status: 'slow' }, { n: 4, status: 'ok' })

    it('says nothing is followed, and what it is looking at', () => {
        render(<FollowedFields theme="dark" events={events} />)
        expect(screen.getByText('No fields followed yet.')).toBeInTheDocument()
        expect(screen.getByTestId('follow-source')).toHaveTextContent('Looking at the newest 4 events held.')
    })

    it('follows a number as a line with its range and says it counts up by one', async () => {
        render(<FollowedFields theme="light" events={events} />)
        await userEvent.type(screen.getByTestId('follow-input'), '$.n')
        await userEvent.click(screen.getByTestId('follow-add'))
        const card = screen.getByTestId('followed-field')
        expect(card).toHaveAttribute('data-path', '$.n')
        expect(within(card).getByTestId('followed-summary')).toHaveTextContent('In 4 of 4 events; newest value 4.')
        expect(within(card).getByRole('img')).toHaveAccessibleName('$.n from 1 to 4, lowest 1, highest 4, counts up by one')
        expect(within(card).getByTestId('followed-numbers')).toHaveTextContent('1 → 4')
        expect(getPins()).toEqual(['$.n'])
    })

    it('follows a text field as its most common values with counts', async () => {
        render(<FollowedFields theme="dark" events={events} />)
        await userEvent.type(screen.getByTestId('follow-input'), 'status')
        await userEvent.click(screen.getByTestId('follow-add'))
        const values = screen.getAllByTestId('followed-value')
        expect(values[0]).toHaveTextContent('ok')
        expect(values[0]).toHaveTextContent('3 (75%)')
        expect(values[1]).toHaveTextContent('slow')
    })

    it('shows the fields pinned elsewhere, and stops following on request', async () => {
        setPins(['$.n', '$.nowhere'])
        render(<FollowedFields theme="dark" events={events} />)
        expect(screen.getAllByTestId('followed-field')).toHaveLength(2)
        expect(screen.getByText('Not in any of the 4 events looked at.')).toBeInTheDocument()
        await userEvent.click(screen.getByRole('button', { name: 'Stop following $.nowhere' }))
        expect(screen.getAllByTestId('followed-field')).toHaveLength(1)
        expect(getPins()).toEqual(['$.n'])
    })

    it('refuses what is not a path, a field already followed, and an empty entry', async () => {
        render(<FollowedFields theme="dark" events={events} />)
        await userEvent.type(screen.getByTestId('follow-input'), 'not a path!')
        await userEvent.click(screen.getByTestId('follow-add'))
        expect(screen.getByTestId('follow-problem')).toHaveTextContent('not a JSON path')
        await userEvent.clear(screen.getByTestId('follow-input'))
        await userEvent.type(screen.getByTestId('follow-input'), '$.n')
        await userEvent.click(screen.getByTestId('follow-add'))
        await userEvent.type(screen.getByTestId('follow-input'), '$.n')
        await userEvent.click(screen.getByTestId('follow-add'))
        expect(screen.getByTestId('follow-problem')).toHaveTextContent('already followed')
        await userEvent.clear(screen.getByTestId('follow-input'))
        await userEvent.click(screen.getByTestId('follow-add'))
        expect(getPins()).toEqual(['$.n'])
    })

    it('offers the fields of the latest payloads as suggestions', () => {
        const { container } = render(<FollowedFields theme="dark" events={events} />)
        expect([...container.querySelectorAll('datalist option')].map((o) => o.getAttribute('value'))).toEqual(['$.n', '$.status'])
    })

    it('follows the saved history when asked, and says that is what it is looking at', async () => {
        const history = Array.from({ length: 3000 }, (_, i) => ev({ n: 3000 - i })) // newest first: 3000 ... 1
        const loadHistory = vi.fn().mockResolvedValue(history)
        setPins(['$.n'])
        render(<FollowedFields theme="dark" events={events} loadHistory={loadHistory} />)
        expect(screen.getByTestId('followed-summary')).toHaveTextContent('In 4 of 4 events')
        await userEvent.click(screen.getByTestId('follow-history'))
        await waitFor(() => expect(screen.getByTestId('follow-source')).toHaveTextContent('Looking at the newest 3,000 events of the saved history.'))
        expect(screen.getByTestId('followed-summary')).toHaveTextContent('In 3,000 of 3,000 events; newest value 3000.')
        await userEvent.click(screen.getByTestId('follow-history'))
        await waitFor(() => expect(screen.getByTestId('followed-summary')).toHaveTextContent('In 4 of 4 events'))
    })

    it('does not offer history where the browser keeps none', () => {
        render(<FollowedFields theme="dark" events={events} />)
        expect(screen.queryByTestId('follow-history')).toBeNull()
    })
})

describe('the type chart with a display mapping', () => {
    const mapped = [ev({ kind: 'delta' }), ev({ kind: 'delta' }), ev({ kind: 'done' }), ev({ other: 1 })]

    it('counts by the mapped type where an event has it, and by the usual one where it does not', () => {
        const shares = typeShares(mapped, 8, (e) => { try { return (JSON.parse(e.data) as { kind?: string }).kind ?? e.type } catch { return e.type } })
        expect(shares.map((s) => [s.type, s.count])).toEqual([['delta', 2], ['done', 1], ['message', 1]])
    })

    it('draws it', () => {
        render(<TypeChart theme="dark" events={mapped} display={{ type: '$.kind' }} />)
        const rows = screen.getAllByTestId('type-row')
        expect(rows[0]).toHaveTextContent('delta')
        expect(rows[0]).toHaveTextContent('2 (50%)')
    })
})
