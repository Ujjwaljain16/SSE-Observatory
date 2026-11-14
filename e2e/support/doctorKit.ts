import fs from 'node:fs'
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import { expect, type Page } from '@playwright/test'
import { frameLog, type LoggedConnection } from '../../src/fixtures/groundTruth'

// Shared by the Stream Doctor end-to-end specs of slice G (doctor.fixtures, doctor.parity, doctor.lifecycle, doctor.canary).
// The fixture server runs inside the Playwright worker (the spec starts it), so a spec reads what the server itself did
// (`server.groundTruth`) and compares it with what the page shows. Nothing here waits for a fixed time: every wait is a
// poll on that log, a test id, or a text.

/** The page is connected straight to the target: the server proxy writes its own comment before the first byte, which would hide a stream that sends nothing. */
export async function connectDirect(page: Page, url: string, options: { token?: string; waitConnected?: boolean } = {}): Promise<void> {
    const proxy = page.getByRole('switch', { name: 'Use server proxy' })
    if ((await proxy.getAttribute('aria-checked')) === 'true') await proxy.click()
    await expect(proxy).toHaveAttribute('aria-checked', 'false')
    await page.getByTestId('url-input').fill(url)
    if (options.token) await page.getByTestId('token-input').fill(options.token)
    await page.getByTestId('connect-button').click()
    if (options.waitConnected !== false) await expect(page.getByTestId('connection-status')).toContainText('Connected', { timeout: 15_000 })
}

export const openDoctor = async (page: Page): Promise<void> => {
    await page.getByTestId('doctor-toggle').click()
    await expect(page.getByTestId('doctor-panel').first()).toBeVisible() // in the lane view there is one panel per lane
}

/** The finding keys on screen, in order. */
export const findingKeys = (page: Page): Promise<string[]> =>
    page.locator('[data-testid="doctor-finding"]').evaluateAll((els) => els.map((e) => e.getAttribute('data-finding-key') ?? ''))

export interface Figure { value: string; note: string }

/** The health strip as {label: value and note}. */
export async function healthStrip(page: Page): Promise<Record<string, Figure>> {
    return page.getByTestId('doctor-health').evaluate((dl) => {
        const out: Record<string, { value: string; note: string }> = {}
        for (const group of Array.from(dl.children)) {
            const label = group.querySelector('dt')?.textContent ?? ''
            const dds = Array.from(group.querySelectorAll('dd')).map((d) => d.textContent ?? '')
            out[label] = { value: dds[0] ?? '', note: dds[1] ?? '' }
        }
        return out
    })
}

/** "850 ms ago" or "4.2 s ago" as milliseconds; undefined for anything else (for example the dash that means never). */
export function ageMs(text: string): number | undefined {
    const m = /^([\d.]+) (ms|s) ago$/.exec(text.trim())
    return m ? Number(m[1]) * (m[2] === 's' ? 1000 : 1) : undefined
}

/** The number in the strip's "N events" note. */
export function eventCountOf(strip: Record<string, Figure>): number {
    const m = /^([\d,]+) events?$/.exec(strip['Last event']?.note ?? '')
    return m ? Number(m[1]!.replace(/,/g, '')) : -1
}

/** Complete (blank-line terminated) events on a connection, as the server's own framer reads them. */
export const framesOf = (c: LoggedConnection): number => frameLog(c).filter((f) => !f.isComment && f.terminated).length

/** Milliseconds since the server last wrote on this connection (a heartbeat counts), from the server's own log. */
export const msSinceLastWrite = (c: LoggedConnection): number => (c.writes.length === 0 ? Infinity : Date.now() - c.writes[c.writes.length - 1]!.epochMs)

/** One download from the open export dialog. A page makes one download only: a second on the same page did not arrive on CI. */
export async function download(page: Page): Promise<{ name: string; text: string }> {
    const [file] = await Promise.all([page.waitForEvent('download'), page.getByTestId('export-download').click()])
    return { name: file.suggestedFilename(), text: fs.readFileSync((await file.path())!, 'utf8') }
}

/** A hand-rolled stream server for what the fixture routes do not do (a connection that sends nothing at all), with a log of its own. */
export interface PlainServer { url: string; connections: Array<{ path: string; writes: number; closed: boolean }>; close(): Promise<void> }
export async function startPlainServer(handler: (req: http.IncomingMessage, res: http.ServerResponse, log: { writes: number }) => void): Promise<PlainServer> {
    const connections: PlainServer['connections'] = []
    const server = http.createServer((req, res) => {
        const entry = { path: req.url ?? '', writes: 0, closed: false }
        res.setHeader('Access-Control-Allow-Origin', '*')
        res.setHeader('Access-Control-Allow-Headers', '*')
        res.setHeader('Access-Control-Expose-Headers', 'Content-Type, Cache-Control, Content-Encoding, Content-Length, X-Accel-Buffering') // what the page may read, as the fixture server allows
        if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return } // the preflight is not a connection
        connections.push(entry)
        const write = res.write.bind(res)
        res.write = ((chunk: unknown, ...rest: unknown[]) => { entry.writes++; return (write as (...a: unknown[]) => boolean)(chunk, ...rest) }) as never
        res.on('close', () => { entry.closed = true })
        handler(req, res, entry)
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()))
    return {
        url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
        connections,
        close: () => new Promise<void>((resolve) => { server.closeAllConnections(); server.close(() => resolve()) }),
    }
}

/** What a well-behaved stream's response headers say, so the checks on headers have nothing to report. */
export const STREAM_HEAD = { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-cache', 'X-Accel-Buffering': 'no' }
