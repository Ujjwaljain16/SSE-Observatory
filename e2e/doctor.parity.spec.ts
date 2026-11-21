import { test, expect, type Page } from '@playwright/test'
import { startFixtureServer, type FixtureServer } from '../src/fixtures/server'
import { maskMeasured } from '../src/core/testing/normalise'
import { connectDirect, download, findingKeys, framesOf, healthStrip, isChromium, msSinceLastWrite, openDoctor } from './support/doctorKit'

// G3: the same stream, once with the SharedWorker that owns connections by default and once with the same client running inside the page
// (the fallback for browsers without SharedWorker, which an init script forces by making it undefined). The shared report (JSON) is taken
// from each and what it concludes is compared: the findings (key, rule, severity, status, the wording with measured numbers masked) and
// the coverage. Times and sequence numbers differ between two live runs and are not compared.

let fx: FixtureServer
test.beforeAll(async () => { fx = await startFixtureServer({ port: 0 }) })
test.afterAll(async () => { await fx.close() })

type Mode = 'worker' | 'fallback'

interface Scenario {
    route: string
    query: Record<string, number>
    /** The finding the stream must produce. */
    finding: string
    /** The profile a person would declare for it, if any. */
    profile?: object
    /** How the run is known to be complete: it ends by itself, or it goes silent. */
    done: 'ended' | 'silent'
}

const SCENARIOS: Scenario[] = [
    { route: 'f04-silent', query: { scale: 0.25 }, finding: 'stall.silent:bytes', done: 'silent' },
    { route: 'f05-drops', query: { scale: 0.25 }, finding: 'reconnect.loop', done: 'ended' },
    { route: 'f06-skips', query: { scale: 0.25 }, finding: 'resume.last-event-id:skipped', profile: { sequence: { useSseId: true, policy: 'consecutive' } }, done: 'ended' },
]

interface Summary {
    keys: string[]
    findings: unknown[]
    coverage: unknown[]
    counts: Record<string, number | undefined>
    reconnectsInStrip: string | undefined
}

/** Which kind of worker the page really has: the target list of the browser knows about shared workers. */
async function sharedWorkerCount(page: Page): Promise<number> {
    const cdp = await page.context().newCDPSession(page)
    const { targetInfos } = await cdp.send('Target.getTargets')
    await cdp.detach()
    return targetInfos.filter((t) => t.type === 'shared_worker').length
}

async function run(page: Page, mode: Mode, s: Scenario): Promise<Summary> {
    if (mode === 'fallback') await page.addInitScript(() => { Object.defineProperty(window, 'SharedWorker', { value: undefined, configurable: true }) })
    if (s.profile) await page.addInitScript((p) => localStorage.setItem('sse.doctor.profile', p), JSON.stringify(s.profile))
    const before = fx.groundTruth.connections.length
    await page.goto('/')
    expect(await page.evaluate(() => typeof SharedWorker), `the page's SharedWorker in ${mode} mode`).toBe(mode === 'worker' ? 'function' : 'undefined')
    await connectDirect(page, fx.urlFor(s.route, s.query), { waitConnected: false })
    await openDoctor(page)
    // The mode is real: a shared worker exists in the browser exactly when the worker is in use. Only Chromium can list its workers (the DevTools
    // protocol); in Firefox and WebKit the check above, that the page's SharedWorker is a function or undefined, is the whole of it.
    if (isChromium(page)) await expect.poll(() => sharedWorkerCount(page), { timeout: 10_000 }).toBe(mode === 'worker' ? 1 : 0)
    await expect(page.locator(`[data-finding-key="${s.finding}"]`)).toBeVisible({ timeout: 60_000 })

    const conns = () => fx.groundTruth.connections.slice(before).filter((c) => c.route === s.route)
    if (s.done === 'ended') {
        await expect.poll(async () => (await healthStrip(page))['Connection']?.value, { timeout: 30_000 }).toBe('ended')
    } else {
        // Silence is judged complete once the server has been quiet for three times the limit the finding needs.
        await expect.poll(() => msSinceLastWrite(conns()[0]!), { timeout: 20_000 }).toBeGreaterThan(3000)
    }
    const mine = conns()
    expect(mine.length, `connections on ${s.route} in ${mode} mode`).toBe(s.route === 'f05-drops' ? 4 : s.route === 'f06-skips' ? 2 : 1)
    expect(framesOf(mine[0]!)).toBeGreaterThan(0)

    const reconnectsInStrip = (await healthStrip(page))['Reconnects']?.value
    const keys = await findingKeys(page)
    await page.getByTestId('doctor-export').click()
    await page.getByLabel(/Report \(JSON\)/).check()
    const ack = page.getByTestId('export-ack')
    if (await ack.count()) await ack.check()
    const file = await download(page)
    expect(file.name).toMatch(/\.report\.json$/)
    const report = JSON.parse(file.text) as { capture: { counts: Record<string, number> }; findings: Array<Record<string, unknown>>; coverage: Array<{ ruleId: string; status: string }> }
    const wording = (f: Record<string, unknown>) => ({
        key: f['key'], ruleId: f['ruleId'], ruleVersion: f['ruleVersion'], severity: f['severity'], status: f['status'],
        deductions: (f['deductions'] as Array<{ statement: string; confidence: string; alternatives: string[] }>).map((d) => ({ statement: maskMeasured(d.statement), confidence: d.confidence, alternatives: d.alternatives.map(maskMeasured) })),
        facts: (f['facts'] as Array<{ text: string }>).map((x) => maskMeasured(x.text)),
    })
    return {
        keys,
        findings: report.findings.map(wording),
        coverage: report.coverage.map((c) => ({ ruleId: c.ruleId, status: c.status })),
        counts: { event: report.capture.counts['event'], connect: report.capture.counts['connect'], reconnect: report.capture.counts['reconnect'] },
        reconnectsInStrip,
    }
}

for (const s of SCENARIOS) {
    test.describe.serial(`G3 ${s.route}: the worker and the in-page fallback reach the same conclusion`, () => {
        const results: Partial<Record<Mode, Summary>> = {}
        for (const mode of ['worker', 'fallback'] as const) {
            test(`${mode}: ${s.finding} is found and the report is taken`, async ({ page }) => {
                test.setTimeout(120_000)
                results[mode] = await run(page, mode, s)
                expect(results[mode]!.keys).toContain(s.finding)
            })
        }
        test('the two reports agree', () => {
            expect(results.worker, 'the worker run did not finish').toBeDefined()
            expect(results.fallback, 'the fallback run did not finish').toBeDefined()
            expect(results.fallback!.keys).toEqual(results.worker!.keys)
            expect(results.fallback!.findings).toEqual(results.worker!.findings)
            expect(results.fallback!.coverage).toEqual(results.worker!.coverage)
            expect(results.fallback!.counts).toEqual(results.worker!.counts)
            expect(results.fallback!.reconnectsInStrip).toBe(results.worker!.reconnectsInStrip)
        })
    })
}
