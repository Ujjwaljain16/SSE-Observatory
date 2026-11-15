import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { RawCopyButton } from '../RawCopyButton'
import { RawValuesLabel } from '../RawValuesLabel'
import RequestView from '../doctor/RequestView'
import SequenceView from '../doctor/SequenceView'
import TimelineView from '../doctor/TimelineView'
import { FindingCard } from '../doctor/FindingCard'
import { observationRegistry } from '../../doctor/observationRegistry'
import { healthyStart } from '../../core/testing/captureBuilder'
import type { DoctorView } from '../../doctor/doctorSession'
import type { Finding } from '../../core/diagnostics'
import { RAW_COPY_CANCEL, RAW_COPY_CONFIRM, RAW_VALUES_LABEL } from '../../utils/rawValues'

afterEach(() => { vi.restoreAllMocks() })

// Q19 (decided): the live views show recorded values as received, say so in the words below, and ask before a raw value is copied.
const LABEL = 'Raw values — as received, not redacted.'

describe('the label', () => {
    it('is exactly the words the owner decided, kept in one constant', () => {
        expect(RAW_VALUES_LABEL).toBe(LABEL)
        render(<RawValuesLabel theme="light" />)
        expect(screen.getByTestId('raw-values-label')).toHaveTextContent(LABEL)
        expect(screen.getByTestId('raw-values-label').textContent).toBe(LABEL)
    })
})

describe('RawCopyButton: the warning before a raw value is copied', () => {
    // A value with the things a copy must not alter: leading and trailing space, a newline, a tab, quotes and non-ASCII.
    const RECEIVED = '  {"token":"eyJhbGciOi.secret","note":"line1\nline2\té中"}  \n'

    const setup = () => {
        const onCopy = vi.fn()
        render(<><button type="button">elsewhere</button><RawCopyButton theme="dark" text={RECEIVED} onCopy={onCopy}>Copy</RawCopyButton></>)
        return onCopy
    }

    it('asks first: nothing is copied by the click that opens the warning, and the warning says what it is', async () => {
        const onCopy = setup()
        await userEvent.click(screen.getByRole('button', { name: 'Copy' }))
        const dialog = screen.getByRole('alertdialog', { name: 'Copy a raw value?' })
        expect(dialog).toHaveAttribute('aria-modal', 'true')
        expect(dialog).toHaveAccessibleDescription(/as received, not redacted.*may contain secrets/)
        expect(within(dialog).getByRole('button', { name: RAW_COPY_CONFIRM })).toBeInTheDocument()
        expect(within(dialog).getByRole('button', { name: RAW_COPY_CANCEL })).toBeInTheDocument()
        expect(onCopy).not.toHaveBeenCalled()
    })

    it('Cancel copies nothing, closes the warning and gives focus back to the Copy button', async () => {
        const onCopy = setup()
        const copy = screen.getByRole('button', { name: 'Copy' })
        await userEvent.click(copy)
        await userEvent.click(screen.getByRole('button', { name: RAW_COPY_CANCEL }))
        expect(onCopy).not.toHaveBeenCalled()
        expect(screen.queryByRole('alertdialog')).toBeNull()
        expect(document.activeElement).toBe(copy)
    })

    it('Escape cancels: nothing is copied', async () => {
        const onCopy = setup()
        await userEvent.click(screen.getByRole('button', { name: 'Copy' }))
        await userEvent.keyboard('{Escape}')
        expect(screen.queryByRole('alertdialog')).toBeNull()
        expect(onCopy).not.toHaveBeenCalled()
    })

    it('a click outside the warning cancels too', async () => {
        const onCopy = setup()
        await userEvent.click(screen.getByRole('button', { name: 'Copy' }))
        const backdrop = screen.getByTestId('raw-copy-dialog').parentElement!
        await userEvent.click(backdrop)
        expect(screen.queryByRole('alertdialog')).toBeNull()
        expect(onCopy).not.toHaveBeenCalled()
    })

    it('Copy anyway copies exactly the received value, once, and closes the warning', async () => {
        const onCopy = setup()
        await userEvent.click(screen.getByRole('button', { name: 'Copy' }))
        await userEvent.click(screen.getByRole('button', { name: RAW_COPY_CONFIRM }))
        expect(onCopy).toHaveBeenCalledTimes(1)
        expect(onCopy.mock.calls[0]![0]).toBe(RECEIVED) // byte for byte: not trimmed, not redacted, not re-serialised
        expect(screen.queryByRole('alertdialog')).toBeNull()
    })

    it('is a real modal: focus starts on Cancel (the safe choice), Tab stays inside, the keyboard alone can confirm', async () => {
        const onCopy = setup()
        await userEvent.click(screen.getByRole('button', { name: 'Copy' }))
        const cancel = screen.getByRole('button', { name: RAW_COPY_CANCEL })
        const confirm = screen.getByRole('button', { name: RAW_COPY_CONFIRM })
        expect(document.activeElement).toBe(cancel)
        await userEvent.tab()
        expect(document.activeElement).toBe(confirm)
        await userEvent.tab()
        expect(document.activeElement).toBe(cancel) // wrapped inside the dialog, not out to the page
        await userEvent.tab({ shift: true })
        expect(document.activeElement).toBe(confirm)
        await userEvent.keyboard('{Enter}')
        expect(onCopy).toHaveBeenCalledWith(RECEIVED)
    })

    it('asks again for the next copy: one approval is not a standing permission', async () => {
        const onCopy = setup()
        await userEvent.click(screen.getByRole('button', { name: 'Copy' }))
        await userEvent.click(screen.getByRole('button', { name: RAW_COPY_CONFIRM }))
        await userEvent.click(screen.getByRole('button', { name: 'Copy' }))
        expect(screen.getByRole('alertdialog')).toBeInTheDocument()
        expect(onCopy).toHaveBeenCalledTimes(1)
    })
})

describe('the live Doctor views carry the label', () => {
    const view = (records: number, over: Record<string, unknown> = {}) => ({ health: { capture: { records } }, nowT: 5000, captureId: 'raw-c', ...over }) as unknown as DoctorView
    const labelled = () => screen.getAllByTestId('raw-values-label').map((l) => l.textContent)

    it('Request: the response headers and the Last-Event-ID are shown as received', () => {
        const b = healthyStart().frame('tick', '1')
        observationRegistry.receive('raw-request', { captureId: 'raw-c', batch: b.observations() })
        render(<RequestView theme="light" streamId="raw-request" view={view(b.observations().length)} />)
        expect(labelled()).toEqual([LABEL])
    })

    it('Timeline: the ids each connection resumed from are shown as received', () => {
        const b = healthyStart().frame('tick', 'abc')
        observationRegistry.receive('raw-timeline', { captureId: 'raw-c', batch: b.observations() })
        render(<TimelineView theme="light" streamId="raw-timeline" view={view(b.observations().length)} />)
        expect(labelled()).toEqual([LABEL])
    })

    it('Sequence: the event ids are shown as received, declared or not', () => {
        const b = healthyStart().frame('tick', 'eyJhbGciOiJIUzI1NiJ9.payload.sig')
        observationRegistry.receive('raw-sequence', { captureId: 'raw-c', batch: b.observations() })
        render(<SequenceView theme="light" streamId="raw-sequence" view={view(b.observations().length)} />)
        expect(labelled()).toEqual([LABEL])
        expect(screen.getByText(/eyJhbGciOiJIUzI1NiJ9\.payload\.sig/)).toBeInTheDocument() // and the value itself is kept exactly as received
    })

    it('a raw record opened from a finding is labelled where it is shown, and the record is unchanged', async () => {
        const b = healthyStart().frame('tick', 'secret-id-1')
        const records = b.observations()
        observationRegistry.receive('raw-finding', { captureId: 'raw-c', batch: records })
        const eventRecord = records.find((r) => r.kind === 'event')!
        const finding = { key: 'x', ruleId: 'R00', ruleVersion: 1, severity: 'info', status: 'open', title: 'T', summary: 'S', facts: [{ text: 'one event', evidence: [{ seq: eventRecord.seq, t: eventRecord.t }] }], deductions: [], limits: [], firstSeenT: 0, occurrences: 1 } as unknown as Finding
        render(<ul><FindingCard theme="light" streamId="raw-finding" finding={finding} defaultOpen /></ul>)
        expect(screen.queryByTestId('raw-values-label')).toBeNull() // nothing raw is on screen until a record is opened
        await userEvent.click(screen.getByRole('button', { name: new RegExp(`record #${eventRecord.seq}`) }))
        expect(labelled()).toEqual([LABEL])
        expect(screen.getByLabelText(`Raw record ${eventRecord.seq}`).textContent).toBe(JSON.stringify(eventRecord, null, 2))
    })

    it('the command Copy in a finding copies a fixed command with a placeholder, not a recorded value, so it asks nothing', async () => {
        const write = vi.fn().mockResolvedValue(undefined)
        Object.defineProperty(navigator, 'clipboard', { value: { writeText: write }, configurable: true })
        const finding = { key: 'x', ruleId: 'R05', ruleVersion: 1, severity: 'warning', status: 'open', title: 'T', summary: 'S', facts: [], deductions: [], nextCheck: { description: 'd', command: 'curl -N "$URL"' }, limits: [], firstSeenT: 0, occurrences: 1 } as unknown as Finding
        render(<ul><FindingCard theme="light" streamId="none" finding={finding} defaultOpen /></ul>)
        await userEvent.click(screen.getByRole('button', { name: 'Copy' }))
        expect(write).toHaveBeenCalledWith('curl -N "$URL"')
        expect(screen.queryByRole('alertdialog')).toBeNull()
    })
})
