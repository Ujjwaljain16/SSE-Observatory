import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import DoctorPanel from '../doctor/DoctorPanel'
import { localCapture } from '../../core/capture/build'
import { serializeCapture } from '../../core/capture/format'
import { redactCapture } from '../../core/capture/redact'
import type { CaptureRecord } from '../../core/capture/format'
import { healthyStart } from '../../core/testing/captureBuilder'
import { resetLibrary } from '../../doctor/captureLibrary'

// The Doctor panel with NOTHING connected (issue 80): the Failure lab has to be reachable from here, because it needs no stream and is the
// quickest way for a first-time visitor to see the product work.
vi.mock('../../context/UIContext', () => ({
    useUIContext: () => ({ requestEventJump: () => {}, jumpResult: null, url: '', setUrl: () => {}, setUseProxy: () => {}, setAppMode: () => {} }),
}))
vi.mock('../../context/StreamContext', () => ({
    useStreamContext: () => ({ connect: () => {}, disconnect: () => {}, allEvents: [], mergedEvents: [] }),
}))

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
        entry({ id: 'f04-silent', title: 'Goes silent', expected: ['stall.silent'], healthyTwin: 'h01', file: 'f04-silent.sse-capture' }),
        entry({ id: 'h01', family: 'H01', title: 'Steady', forbidden: ['*'], file: 'h01.sse-capture' }),
    ],
    skipped: [],
}

beforeEach(async () => {
    localStorage.clear()
    await wipe()
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
        const name = url.split('/').pop()!
        if (name === 'index.json') return new Response(JSON.stringify(INDEX), { status: 200 })
        if (name === 'f04-silent.sse-capture') return new Response(silent(), { status: 200 })
        if (name === 'h01.sse-capture') return new Response(healthy(), { status: 200 })
        return new Response('nope', { status: 404 })
    }))
})
afterEach(async () => { vi.unstubAllGlobals(); localStorage.clear(); await wipe() })

describe('the Failure lab with no stream connected', () => {
    it('offers the lab from the empty Doctor, next to what the empty state already said', () => {
        render(<DoctorPanel theme="dark" streamId="main" />)
        expect(screen.getByTestId('doctor-empty')).toHaveTextContent('Connect to a stream')
        expect(screen.getByText('Set up a profile before connecting')).toBeInTheDocument()
        const entryPoint = screen.getByTestId('doctor-try-lab')
        expect(entryPoint).toHaveTextContent('Try the Failure lab')
        expect(entryPoint).toHaveTextContent('no backend needed')
        // nothing is fetched or shown until it is asked for
        expect(screen.queryByTestId('failure-lab')).toBeNull()
        expect(fetch).not.toHaveBeenCalled()
    })

    it('opens the lab from it, already open, and runs a faulty stream and then its healthy twin', async () => {
        render(<DoctorPanel theme="light" streamId="main" />)
        await userEvent.click(screen.getByTestId('doctor-try-lab'))
        // the Captures tab's section, with the lab expanded and its list loaded without a second click
        // (the tab and the lab are separate lazy chunks: the first load can be slow on a busy machine)
        expect(await screen.findByTestId('doctor-captures', {}, { timeout: 15_000 })).toBeInTheDocument()
        expect(await screen.findAllByTestId('lab-entry', {}, { timeout: 15_000 })).toHaveLength(2)

        await userEvent.click(screen.getByRole('button', { name: 'Run the Doctor on f04-silent' }))
        const result = await screen.findByTestId('lab-result')
        expect(within(result).getByTestId('lab-verdict')).toHaveTextContent('found what this stream was built to show')
        expect(within(result).getByTestId('lab-expectations')).toHaveTextContent('Expected stall.silent: found')

        await userEvent.click(screen.getByTestId('lab-twin'))
        await waitFor(() => expect(screen.getByRole('heading', { name: /h01: Steady/ })).toBeInTheDocument())
        expect(screen.getByTestId('lab-expectations')).toHaveTextContent('No finding at all: none appeared')
    })

    it('does not offer to save a recording that does not exist, and lets the lab be put away again', async () => {
        render(<DoctorPanel theme="dark" streamId="main" />)
        await userEvent.click(screen.getByTestId('doctor-try-lab'))
        await screen.findAllByTestId('lab-entry', {}, { timeout: 15_000 })
        expect(screen.queryByTestId('capture-save')).toBeNull()
        await userEvent.click(screen.getByTestId('doctor-try-lab'))
        expect(screen.queryByTestId('failure-lab')).toBeNull()
        expect(screen.getByTestId('doctor-empty')).toBeInTheDocument()
    })

    it('is still offered when recording is switched off in this browser, because the lab records nothing', () => {
        localStorage.setItem('sse.recording', 'off')
        render(<DoctorPanel theme="dark" streamId="main" />)
        expect(screen.getByTestId('doctor-empty')).toHaveTextContent('Recording is switched off')
        expect(screen.getByTestId('doctor-try-lab')).toBeInTheDocument()
    })

    it('is not offered inside a lane list, where the empty card belongs to one stream', () => {
        render(<DoctorPanel theme="dark" streamId="lane-1" heading="h3" title="Lane 1" />)
        expect(screen.queryByTestId('doctor-try-lab')).toBeNull()
    })
})
