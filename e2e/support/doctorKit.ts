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

/** Chromium has the DevTools protocol and permissions the other engines do not; a test that needs them asks. */
export const isChromium = (page: Page): boolean => page.context().browser()?.browserType().name() === 'chromium'

/**
 * The system clipboard, read from outside the page's own state. Chromium lets a test grant `clipboard-read` and read it back; Firefox and WebKit have
 * no such permission (Playwright says "Unknown permission: clipboard-read"), so there the text is pasted with the keyboard into a scratch field and
 * read from that: still the real clipboard, still not the page's own record of what it copied. The field is put inside an open dialog when there is
 * one (a modal dialog keeps focus inside itself), and focus goes back to where it was.
 */
export const isWebkit = (page: Page): boolean => page.context().browser()?.browserType().name() === 'webkit'

/**
 * Call before the first navigation. In Playwright's WebKit the system clipboard cannot be read back (a paste into a field yields nothing, and the
 * permission API does not exist), so there the page's navigator.clipboard.writeText is replaced by a recorder and the tests read what the page
 * handed to the clipboard API: the only way the app writes the clipboard. Chromium and Firefox read the real clipboard and need no call.
 */
export async function trackClipboard(page: Page): Promise<void> {
    if (!isWebkit(page)) return
    await page.addInitScript(() => {
        const spy = { text: '', calls: 0 }
        ;(window as unknown as { __clipboardSpy: typeof spy }).__clipboardSpy = spy
        const replacement = (t: string): Promise<void> => { spy.text = String(t); spy.calls++; return Promise.resolve() }
        Object.defineProperty(Object.getPrototypeOf(navigator.clipboard), 'writeText', { value: replacement, configurable: true })
    })
}

export async function readClipboard(page: Page): Promise<string> {
    if (isWebkit(page)) return page.evaluate(() => (window as unknown as { __clipboardSpy: { text: string } }).__clipboardSpy.text)
    if (isChromium(page)) return page.evaluate(() => navigator.clipboard.readText())
    await page.evaluate(() => {
        const field = document.createElement('textarea')
        field.id = '__clipboard-probe'
        field.setAttribute('aria-hidden', 'true')
        field.style.cssText = 'position:fixed;left:0;top:0;width:8px;height:8px;opacity:0'
        ;(document.querySelector('[role="alertdialog"], [role="dialog"]') ?? document.body).appendChild(field)
        ;(window as unknown as { __clipboardFocus: Element | null }).__clipboardFocus = document.activeElement
        field.focus()
    })
    await page.keyboard.press('ControlOrMeta+V')
    const text = await page.locator('#__clipboard-probe').inputValue()
    await page.evaluate(() => {
        document.getElementById('__clipboard-probe')?.remove()
        const was = (window as unknown as { __clipboardFocus: Element | null }).__clipboardFocus
        if (was instanceof HTMLElement) was.focus()
    })
    return text
}

/** Puts text on the system clipboard the way a person does (select it, copy it), which works in every browser; Chromium also needs the permission granted. */
export async function writeClipboard(page: Page, text: string): Promise<void> {
    if (isWebkit(page)) { await page.evaluate((t) => { (window as unknown as { __clipboardSpy: { text: string } }).__clipboardSpy.text = t }, text); return }
    if (isChromium(page)) await page.context().grantPermissions(['clipboard-read', 'clipboard-write']) // the others have no such permission
    await page.evaluate((t) => {
        const field = document.createElement('textarea')
        field.id = '__clipboard-source'
        field.setAttribute('aria-hidden', 'true')
        field.style.cssText = 'position:fixed;left:0;top:0;width:8px;height:8px;opacity:0'
        field.value = t
        ;(window as unknown as { __clipboardFocus: Element | null }).__clipboardFocus = document.activeElement
        ;(document.querySelector('[role="alertdialog"], [role="dialog"]') ?? document.body).appendChild(field)
        field.focus()
        field.select()
    }, text)
    await page.keyboard.press('ControlOrMeta+C')
    await page.evaluate(() => {
        document.getElementById('__clipboard-source')?.remove()
        const was = (window as unknown as { __clipboardFocus: Element | null }).__clipboardFocus
        if (was instanceof HTMLElement) was.focus()
    })
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
