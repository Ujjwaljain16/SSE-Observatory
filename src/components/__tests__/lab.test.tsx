import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import FailureLab from '../doctor/FailureLab'
import { localCapture } from '../../core/capture/build'
import { serializeCapture } from '../../core/capture/format'
import { redactCapture } from '../../core/capture/redact'
import type { CaptureRecord } from '../../core/capture/format'
import { healthyStart } from '../../core/testing/captureBuilder'
import { listCaptures, resetLibrary } from '../../doctor/captureLibrary'

async function wipe() {
    resetLibrary()
    await new Promise<void>((resolve) => {
        const req = indexedDB.deleteDatabase('sse-doctor-db')
        req.onsuccess = () => resolve()
        req.onerror = () => resolve()
        req.onblocked = () => resolve()
    })
    resetLibrary()
}

const make = (b: ReturnType<typeof healthyStart>, endT?: number) => {
    const c = localCapture(b.observations() as CaptureRecord[], { source: { kind: 'fixture' }, request: { url: 'https://lab.example/x', method: 'GET' } })
    if (endT !== undefined) c.footer = { ...(c.footer ?? { endReason: 'stopped', counts: {} }), endT }
    return serializeCapture(redactCapture(c).capture)
}
const silent = () => { const b = healthyStart().repeat(14, 250, (x, i) => x.frame('tick', String(i + 1))); return make(b, b.now + 90_000) }
const healthy = () => make(healthyStart().repeat(6, 250, (x, i) => x.frame('tick', String(i + 1))))

const entry = (over: Record<string, unknown>) => ({ family: 'F04', title: 'T', description: 'D', expected: [], forbidden: [], healthyTwin: null, file: 'x.sse-capture', events: 6, seconds: 1, scale: 0.25, ...over })
const INDEX = {
    schemaVersion: 1,
    entries: [
        entry({ id: 'f04-silent', title: 'Goes silent', expected: ['stall.silent'], forbidden: [], healthyTwin: 'h01', file: 'f04-silent.sse-capture' }),
        entry({ id: 'h01', family: 'H01', title: 'Steady', expected: [], forbidden: ['*'], file: 'h01.sse-capture' }),
        entry({ id: 'wrong', title: 'Claims a finding it will not have', expected: ['stall.silent'], forbidden: [], file: 'h01.sse-capture' }),
    ],
    skipped: [{ id: 'f10-steady', family: 'F10', title: 'Slow consumer', reason: 'it needs page-side samples a plain run does not have' }],
}

beforeEach(async () => {
    await wipe()
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
        const name = url.split('/').pop()!
        if (name === 'index.json') return new Response(JSON.stringify(INDEX), { status: 200 })
        if (name === 'f04-silent.sse-capture') return new Response(silent(), { status: 200 })
        if (name === 'h01.sse-capture') return new Response(healthy(), { status: 200 })
        return new Response('nope', { status: 404 })
    }))
})
afterEach(async () => { vi.unstubAllGlobals(); await wipe() })

const openLab = async () => {
    render(<FailureLab theme="dark" onSaved={() => {}} />)
    await userEvent.click(screen.getByText('Failure lab'))
    await screen.findAllByTestId('lab-entry')
}

describe('FailureLab', () => {
    it('loads the lab when opened, grouped by family, and lists what could not be shown and why', async () => {
        await openLab()
        // grouped: the two F04 entries first, then the healthy one
        expect(screen.getAllByTestId('lab-entry').map((e) => e.getAttribute('data-id'))).toEqual(['f04-silent', 'wrong', 'h01'])
        expect(screen.getByRole('heading', { name: 'F04' })).toBeInTheDocument()
        expect(screen.getByRole('heading', { name: 'Healthy streams' })).toBeInTheDocument()
        await userEvent.click(screen.getByText(/Not in the lab \(1\)/))
        expect(screen.getByTestId('lab-skipped')).toHaveTextContent('f10-steady: it needs page-side samples')
    })

    it('runs the Doctor on a fault, says it found what the stream was built to show, and shows the finding', async () => {
        await openLab()
        await userEvent.click(screen.getByRole('button', { name: 'Run the Doctor on f04-silent' }))
        const result = await screen.findByTestId('lab-result')
        expect(within(result).getByTestId('lab-verdict')).toHaveTextContent('found what this stream was built to show')
        expect(within(result).getByTestId('lab-expectations')).toHaveTextContent('Expected stall.silent: found')
        expect(within(result).getByTestId('doctor-finding')).toBeInTheDocument()
    })

    it('says so, with the reason, when the Doctor did not match what the stream claims', async () => {
        await openLab()
        await userEvent.click(screen.getByRole('button', { name: 'Run the Doctor on wrong' }))
        const verdict = await screen.findByTestId('lab-verdict')
        expect(verdict).toHaveTextContent('did not match')
        expect(verdict).toHaveTextContent('stall.silent was expected but not found')
        expect(screen.getByTestId('lab-expectations')).toHaveTextContent('Expected stall.silent: not found')
    })

    it('shows a healthy twin with no findings, and does not call it proof of health', async () => {
        await openLab()
        await userEvent.click(screen.getByRole('button', { name: 'Run the Doctor on f04-silent' }))
        await screen.findByTestId('lab-result')
        await userEvent.click(screen.getByTestId('lab-twin'))
        await waitFor(() => expect(screen.getByRole('heading', { name: /h01: Steady/ })).toBeInTheDocument())
        expect(screen.getByTestId('lab-expectations')).toHaveTextContent('No finding at all: none appeared')
        expect(screen.getByTestId('lab-result')).toHaveTextContent('No findings.')
    })

    it('saves the capture it is showing to the library', async () => {
        const onSaved = vi.fn()
        render(<FailureLab theme="light" onSaved={onSaved} />)
        await userEvent.click(screen.getByText('Failure lab'))
        await screen.findAllByTestId('lab-entry')
        await userEvent.click(screen.getByRole('button', { name: 'Run the Doctor on f04-silent' }))
        await screen.findByTestId('lab-result')
        await userEvent.click(screen.getByTestId('lab-save'))
        await waitFor(() => expect(screen.getByTestId('lab-notice')).toHaveTextContent('Saved "Lab: f04-silent"'))
        expect((await listCaptures()).map((c) => c.name)).toEqual(['Lab: f04-silent'])
        expect(onSaved).toHaveBeenCalled()
    })

    it('says plainly when the lab cannot be loaded, and when a capture cannot', async () => {
        vi.stubGlobal('fetch', vi.fn(async () => new Response('x', { status: 500 })))
        render(<FailureLab theme="dark" onSaved={() => {}} />)
        await userEvent.click(screen.getByText('Failure lab'))
        expect(await screen.findByTestId('lab-error')).toHaveTextContent('The lab could not be loaded (HTTP 500)')
    })
})
