import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import FleetStrip from '../doctor/FleetStrip'
import PrivacySettings from '../doctor/PrivacySettings'
import { getProfile, setProfile } from '../../doctor/profileStore'
import type { DoctorView } from '../../doctor/doctorSession'
import * as download from '../../doctor/download'

const open = (o: Partial<Record<'info' | 'warning' | 'error' | 'critical', number>> = {}) => ({ info: 0, warning: 0, error: 0, critical: 0, ...o })

function view(over: { phase?: string; events?: number; lastEventAgeMs?: number | null; worst?: DoctorView['worst']; open?: ReturnType<typeof open>; lag?: number } = {}): DoctorView {
    return {
        streamId: 'x', captureId: 'c', profile: undefined, nowT: 0, findings: [], coverage: [], open: over.open ?? open(), worst: over.worst ?? null, evaluated: 0, notEvaluated: 0,
        health: {
            phase: over.phase ?? 'open', attempt: 0, phaseAgeMs: 0, lastByteAgeMs: null, lastOriginAgeMs: null, lastEventAgeMs: over.lastEventAgeMs === undefined ? 200 : over.lastEventAgeMs,
            proxyBeatAgeMs: null, originBeats: 0, proxyBeats: 0, originBeatMedianMs: null, events: over.events ?? 10, reconnects: 0,
            consumer: over.lag === undefined ? null : { samples: 3, p95LagMs: over.lag, queueDepth: 0 },
            capture: { records: 20, retainedBytes: 2048, capBytes: 8_388_608, dropped: 0 },
        },
    }
}
const lanes = [{ id: 'a', name: 'orders' }, { id: 'b', name: 'prices' }]

beforeEach(() => { localStorage.clear(); setProfile(undefined) })

describe('FleetStrip', () => {
    it('shows nothing with no lanes', () => {
        const { container } = render(<FleetStrip theme="dark" lanes={[]} views={new Map()} />)
        expect(container).toBeEmptyDOMElement()
    })

    it('shows the lanes added up: how many and in what state, events and rate, open findings, the quietest lane, the slowest', () => {
        const views = new Map([
            ['a', view({ events: 120, open: open({ warning: 1 }), worst: 'warning', lag: 40 })],
            ['b', view({ events: 30, phase: 'reconnecting', open: open({ error: 2 }), worst: 'error', lastEventAgeMs: 9000, lag: 300 })],
        ])
        render(<FleetStrip theme="light" lanes={lanes} views={views} ratePerSecond={42.4} />)
        expect(screen.getByTestId('fleet-lanes')).toHaveTextContent('2')
        expect(screen.getByTestId('fleet-lanes')).toHaveTextContent('1 open, 1 reconnecting')
        expect(screen.getByTestId('fleet-events')).toHaveTextContent('150')
        expect(screen.getByTestId('fleet-events')).toHaveTextContent('42 events/s')
        expect(screen.getByTestId('fleet-open-findings')).toHaveTextContent('2 errors, 1 warning')
        expect(screen.getByTestId('fleet-open-findings')).toHaveTextContent('worst: error')
        expect(screen.getByTestId('fleet-slowest-page-processing')).toHaveTextContent('p95 300 ms')
        expect(screen.getByTestId('fleet-slowest-page-processing')).toHaveTextContent('prices')
    })

    it('says "none" for open findings and that it is not proof of health', () => {
        render(<FleetStrip theme="dark" lanes={lanes} views={new Map([['a', view()], ['b', view()]])} />)
        expect(screen.getByTestId('fleet-open-findings')).toHaveTextContent('none')
        expect(screen.getByTestId('fleet-open-findings')).toHaveTextContent('not proof of health')
    })

    it('lists each lane in a table, with its state, and "not recorded" for a lane with no Doctor view', () => {
        render(<FleetStrip theme="dark" lanes={lanes} views={new Map([['a', view({ events: 7 })]])} />)
        const rows = within(screen.getByTestId('fleet-table')).getAllByRole('row')
        expect(rows).toHaveLength(3) // header and two lanes
        expect(rows[1]).toHaveTextContent('orders')
        expect(rows[1]).toHaveTextContent('open')
        expect(rows[2]).toHaveTextContent('prices')
        expect(rows[2]).toHaveTextContent('not recorded')
    })

    it('saves the summary as a JSON file of counts and names', async () => {
        const save = vi.spyOn(download, 'downloadText').mockImplementation(() => {})
        render(<FleetStrip theme="dark" lanes={lanes} views={new Map([['a', view({ events: 7 })]])} ratePerSecond={5} />)
        await userEvent.click(screen.getByTestId('fleet-save'))
        expect(save).toHaveBeenCalledTimes(1)
        const [name, text, mime] = save.mock.calls[0]!
        expect(name).toBe('sse-fleet.json')
        expect(mime).toBe('application/json')
        expect(JSON.parse(text)).toMatchObject({ schemaVersion: 1, lanes: 2, events: 7, eventsPerSecond: 5 })
        save.mockRestore()
    })
})

describe('the payload structure switch in the Privacy panel', () => {
    it('is on by default, and turning it off keeps only shapes:false in the profile, so the command line reads it too', async () => {
        render(<PrivacySettings theme="dark" count={0} onChanged={() => {}} />)
        const box = screen.getByTestId('privacy-shapes')
        expect(box).toBeChecked()
        await userEvent.click(box)
        expect(getProfile()).toEqual({ shapes: false })
        await userEvent.click(box)
        expect(getProfile()).toBeUndefined() // nothing else was declared, so nothing is stored
    })

    it('leaves the rest of the profile alone either way', async () => {
        setProfile({ delivery: 'at_least_once', timestampField: '$.ts' })
        render(<PrivacySettings theme="light" count={0} onChanged={() => {}} />)
        await userEvent.click(screen.getByTestId('privacy-shapes'))
        expect(getProfile()).toEqual({ delivery: 'at_least_once', timestampField: '$.ts', shapes: false })
        await userEvent.click(screen.getByTestId('privacy-shapes'))
        expect(getProfile()).toEqual({ delivery: 'at_least_once', timestampField: '$.ts' })
    })

    it('shows as off when the profile says so', () => {
        setProfile({ shapes: false })
        render(<PrivacySettings theme="dark" count={0} onChanged={() => {}} />)
        expect(screen.getByTestId('privacy-shapes')).not.toBeChecked()
    })
})
