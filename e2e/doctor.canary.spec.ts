import { test, expect, type Page } from '@playwright/test'
import { startFixtureServer, type FixtureServer } from '../src/fixtures/server'
import { ARTIFACTS, type ArtifactKind } from '../src/doctor/artifacts'
import { canaries, survivors, type Canary } from '../src/core/testing/canaries'
import { connectDirect, download, findingKeys, framesOf, healthStrip, isChromium, openDoctor, readClipboard, startPlainServer, STREAM_HEAD, type PlainServer } from './support/doctorKit'

// G6 / E1 (the browser half): planted secrets (src/core/testing/canaries.ts) go in through the app's real inputs (the URL box, the bearer token box)
// and through what a server sends (comments, ids, a Set-Cookie header), the Doctor is opened, every artifact is exported, and the file, the dialog's
// preview and the rest of the Doctor are searched for each secret in five encodings (as written, percent-encoded, base64, base64url, JSON-escaped).
// A class R secret (one that redaction must remove) in any shareable artifact is a release blocker. A class F secret (random text no rule can know) must
// be flagged by the scan and held behind an acknowledgement. A class L secret (a sentence) is documented as kept and not flagged, and pinned.
//
// What the app's UI cannot send is not tested here: it has no box for a cookie or a custom header, fetch is made without credentials, and the server proxy
// forwards only Authorization. Those placements are covered where they can be reached (the Doctor's artifacts and the command line, `artifacts.canary.test.ts`).

const C = canaries(15)
const R = (names: string[]): Canary[] => names.map((n) => C[n]!)

let fx: FixtureServer
let plain: PlainServer
test.beforeAll(async () => {
    fx = await startFixtureServer({ port: 0 })
    // A server that leaks the way real ones do: in comments, in ids, and in the bodies of events.
    plain = await startPlainServer((_req, res) => {
        res.writeHead(200, STREAM_HEAD)
        res.write(`: debug api_key=${C['keyValueComment']!.value}\n\n`)
        res.write(`: debug auth ${C['jwtInPayload']!.value}\n\n`)
        res.write(`: session ${C['freeToken']!.value}\n\n`)
        res.write(`: note ${C['sentence']!.value}\n\n`)
        let i = 0
        const timer = setInterval(() => {
            i++
            const id = i === 1 ? C['jwtInId']!.value : i === 2 ? C['idToken']!.value : String(i)
            const body = JSON.stringify({ n: i, user: { name: 'ada', password: C['passwordNested']!.value }, items: [{ token: C['tokenInArray']!.value }], jwt: C['jwtInPayload']!.value })
            res.write(`id: ${id}\nevent: tick\ndata: ${body}\n\n`)
            if (i === 4) { clearInterval(timer); res.write('event: end\ndata: done\n\n'); res.end() }
        }, 50)
        res.on('close', () => clearInterval(timer))
    })
})
test.afterAll(async () => { await fx.close(); await plain.close() })

interface Scenario {
    name: string
    /** What the page is given. */
    start(page: Page): Promise<void>
    /** The planted secrets that must not survive redaction, and the ones that are flagged or pinned. */
    must: Canary[]
    flagged: Canary[]
    limit: Canary[]
    /** The kinds to export in this scenario (all of them, unless the scenario says otherwise). */
    kinds?: ArtifactKind[]
    /** The stream carries a token as an event id, which the live Sequence view lists as received. */
    idsShownAsRecorded?: boolean
}

const urlSecrets = () => ({ token: C['urlToken']!.value, api_key: C['urlApiKey']!.value, idtoken: C['jwtInId']!.value, sc: C['setCookie']!.value.replace(/^sid=/, '') })
const bearer = () => C['authorization']!.value

const SCENARIOS: Scenario[] = [
    {
        name: 'echo, direct: a bearer token, query values, a token as an event id, a Set-Cookie',
        async start(page) {
            const before = fx.groundTruth.of('f08-echo').length
            await connectDirect(page, fx.urlFor('f08-echo', urlSecrets()), { token: bearer(), waitConnected: false })
            await expect.poll(() => fx.groundTruth.of('f08-echo')[before]?.endedBy).toBe('server-end')
        },
        must: R(['authorization', 'urlToken', 'urlApiKey', 'setCookie', 'jwtInId']), flagged: [], limit: [], idsShownAsRecorded: true,
    },
    {
        name: 'echo, through the server proxy (the default)',
        async start(page) {
            const before = fx.groundTruth.of('f08-echo').length
            await page.goto('/')
            await page.getByTestId('url-input').fill(fx.urlFor('f08-echo', urlSecrets()))
            await page.getByTestId('token-input').fill(bearer())
            await page.getByTestId('connect-button').click()
            await expect.poll(() => fx.groundTruth.of('f08-echo')[before]?.endedBy, { timeout: 15_000 }).toBe('server-end')
        },
        must: R(['authorization', 'urlToken', 'urlApiKey', 'setCookie', 'jwtInId']), flagged: [], limit: [], idsShownAsRecorded: true,
        kinds: ['report-md', 'report-json', 'capture-shared', 'capture-local'],
    },
    {
        name: 'a URL with a password in it (the browser refuses it, and says why)',
        async start(page) {
            const url = fx.urlFor('f08-echo', urlSecrets()).replace('http://', `http://user:${C['userinfo']!.value}@`)
            await connectDirect(page, url, { token: bearer(), waitConnected: false })
            // three refused attempts (1 s and 2 s of back-off) are what the Doctor calls a loop; the message under the box counts the attempts
            await expect(page.getByText(/\(attempt 3\)/)).toBeVisible({ timeout: 30_000 })
        },
        must: R(['authorization', 'urlToken', 'urlApiKey', 'setCookie', 'jwtInId', 'userinfo']), flagged: [], limit: [],
    },
    {
        name: 'a server that leaks in comments, ids and event bodies',
        async start(page) {
            const before = plain.connections.length
            await connectDirect(page, `${plain.url}/leaky?token=${C['urlToken']!.value}`, { token: bearer(), waitConnected: false })
            await expect.poll(() => plain.connections[before]?.closed, { timeout: 15_000 }).toBe(true)
        },
        must: R(['authorization', 'urlToken', 'jwtInPayload', 'jwtInId', 'keyValueComment', 'passwordNested', 'tokenInArray']),
        flagged: R(['freeToken', 'idToken']), limit: R(['sentence']), idsShownAsRecorded: true,
    },
]

const LABEL: Record<ArtifactKind, RegExp> = {
    'report-md': /Report \(Markdown\)/, 'report-issue': /For an issue or pull request/, 'report-html': /Report \(HTML\)/, 'report-json': /Report \(JSON\)/,
    'capture-shared': /Capture to share/, curl: /curl command/, scenario: /Test scenario/, repro: /Smallest capture/, 'capture-local': /Full local capture/,
}

const PREVIEW_CHARS = 4000

const found = (text: string, list: Canary[]): string[] => list.flatMap((c) => survivors(text, c).map((form) => `${c.placement}: ${form.slice(0, 12)}…`))

async function openDialog(page: Page): Promise<void> {
    await openDoctor(page)
    await page.getByTestId('doctor-export').click()
    await expect(page.getByTestId('export-dialog')).toBeVisible()
}

/** The preview as the dialog shows it, and what it should be for a file with this text. */
const expectedPreview = (text: string): string => (text.length > PREVIEW_CHARS ? `${text.slice(0, PREVIEW_CHARS)}\n… ${(text.length - PREVIEW_CHARS).toLocaleString('en-US')} more characters in the file` : text)

const stored = (page: Page): Promise<string> => page.evaluate(() => JSON.stringify({ local: { ...localStorage }, session: { ...sessionStorage } }))

for (const s of SCENARIOS) {
    test.describe(`G6 canary sweep: ${s.name}`, () => {
        const kinds = ARTIFACTS.filter((a) => !s.kinds || s.kinds.includes(a.kind))
        for (const artifact of kinds) {
            test(`${artifact.kind}: the file, the preview and the page${artifact.shareable ? ' hold no secret' : ' is the recording as it is'}`, async ({ page }) => {
                test.setTimeout(90_000)
                await page.goto('/')
                await s.start(page)
                await openDialog(page)
                const dialog = page.getByTestId('export-dialog')
                await page.getByLabel(LABEL[artifact.kind]).check()
                if (artifact.kind === 'repro') {
                    await page.getByRole('button', { name: 'Find the smallest capture' }).click()
                    await expect(dialog.getByText(/Reduced from|does not appear when the capture is analysed again/)).toBeVisible({ timeout: 30_000 })
                }
                const preview = await dialog.getByLabel(/Preview of/).evaluate((el) => el.textContent ?? '')
                const dialogText = await dialog.innerText()

                // A free-text token no rule can know is kept, so the scan must flag it, and sharing waits for a person.
                const residual = page.getByTestId('export-residual')
                const flagged = (await residual.count()) > 0
                const residualText = flagged ? await residual.innerText() : ''
                if (flagged) await expect(page.getByTestId('export-download')).toBeDisabled()
                const ack = page.getByTestId('export-ack')
                if (await ack.count()) await ack.check()
                const file = await download(page)
                if (artifact.shareable && s.flagged.length > 0) {
                    // The smallest capture drops the records that are not needed, and may drop the token with them. Every other file made from this
                    // recording keeps it, and so is flagged.
                    if (artifact.kind !== 'repro') expect(flagged, `${artifact.kind}: a random token in free text must be flagged`).toBe(true)
                    if (found(file.text, s.flagged).length > 0) expect(flagged, `${artifact.kind} holds a random token that was not flagged`).toBe(true)
                    expect(found(residualText, [...s.flagged, ...s.limit]), 'the scan must describe what it found without printing it').toEqual([])
                }

                // The preview is the file's first 4000 characters, nothing else.
                expect(preview).toBe(expectedPreview(file.text))
                if (artifact.shareable) {
                    expect(found(file.text, s.must), `${artifact.kind}: a secret survived in the file ${file.name}`).toEqual([])
                    expect(found(preview, s.must), `${artifact.kind}: a secret is in the preview`).toEqual([])
                    expect(found(dialogText, s.must), `${artifact.kind}: a secret is in the dialog`).toEqual([])
                } else {
                    // The full local capture is the recording as it is: what the page received is in it. A header value never is (the recorder keeps names only),
                    // and a query value is already a placeholder.
                    expect(found(file.text, R(['authorization', 'urlToken', 'urlApiKey', 'setCookie'].filter((n) => s.must.includes(C[n]!)))), 'the local capture holds a value the recorder should never keep').toEqual([])
                }

                // Where a secret may be left on purpose, and where it may not be.
                if (artifact.kind === 'capture-shared' && s.flagged.length > 0) {
                    expect(found(file.text, s.flagged).length, 'a random token in free text is kept by redaction (the scan flags it)').toBeGreaterThan(0)
                    expect(found(file.text, s.limit).length, 'a low-entropy sentence is kept and not flagged: the documented limit').toBeGreaterThan(0)
                }
                // Nothing was put in the browser's storage.
                expect(found(await stored(page), [...s.must, ...s.flagged, ...s.limit]), 'a secret is in localStorage or sessionStorage').toEqual([])
            })
        }

        test('no part of the Doctor shows a planted secret: findings (evidence opened), request, flow, timeline, sequence', async ({ page }) => {
            test.setTimeout(90_000)
            await page.goto('/')
            await s.start(page)
            await openDoctor(page)
            const panel = page.getByTestId('doctor-panel').first()
            // The text of a surface without the raw records the evidence chips open (those are the recording as received: see the pinned test below).
            const text = () => panel.evaluate((el) => { const copy = el.cloneNode(true) as HTMLElement; copy.querySelectorAll('pre').forEach((p) => p.remove()); return copy.textContent ?? '' })
            const attributes = () => panel.evaluate((el) => Array.from(el.querySelectorAll('*')).flatMap((n) => ['aria-label', 'title', 'alt', 'href', 'value'].map((a) => n.getAttribute(a) ?? '')).filter(Boolean).join('\n'))
            for (const chip of await panel.getByRole('button', { name: /record #\d+/ }).all()) await chip.click().catch(() => undefined)
            const surfaces: Record<string, string> = { findings: `${await text()}\n${await attributes()}` }
            for (const tab of ['request', 'flow', 'timeline', 'sequence'] as const) {
                await page.getByTestId(`doctor-tab-${tab}`).click()
                surfaces[tab] = `${await text()}\n${await attributes()}`
            }
            // Q19 (decided, campaign page): the live Doctor shows what was recorded, as received, and labels it ("Raw values — as received, not redacted."; see
            // doctor.raw.spec.ts). The Sequence view lists the event ids as received, so a token used as an event id is on screen there (the exports redact it; the
            // screen does not). Kept on purpose: the exact received values stay.
            const asRecorded = s.idsShownAsRecorded ? [C['jwtInId']!] : []
            if (s.idsShownAsRecorded) expect(found(surfaces['sequence']!, asRecorded).length, 'the Sequence view lists the ids as received').toBeGreaterThan(0)
            const mustNotShow = s.must.filter((c) => !asRecorded.includes(c))
            for (const [surface, shown] of Object.entries(surfaces)) {
                expect(found(shown, mustNotShow), `a secret is shown by the Doctor's ${surface} view`).toEqual([])
                if (surface !== 'sequence') expect(found(shown, asRecorded), `an id token is shown by the Doctor's ${surface} view`).toEqual([])
            }
            expect(found(await stored(page), [...s.must, ...s.flagged, ...s.limit])).toEqual([])
        })
    })
}

test.describe('G6: what Copy puts on the clipboard', () => {
    test('is the command that is shown, and holds no secret', async ({ page, context }) => {
        test.setTimeout(90_000)
        if (isChromium(page)) await context.grantPermissions(['clipboard-read', 'clipboard-write']) // Firefox and WebKit have no such permission: readClipboard pastes there
        const before = fx.groundTruth.connections.length
        await page.goto('/')
        await connectDirect(page, fx.urlFor('f04-silent', { scale: 0.25, token: C['urlToken']!.value, api_key: C['urlApiKey']!.value }), { token: bearer() })
        await openDoctor(page)
        const finding = page.locator('[data-finding-key="stall.silent:bytes"]')
        await expect(finding).toBeVisible({ timeout: 30_000 })
        // Only the worst finding starts open; a warning about the credential in the URL can be listed before this one.
        const header = finding.getByRole('button').first()
        if ((await header.getAttribute('aria-expanded')) !== 'true') await header.click()
        await expect(header).toHaveAttribute('aria-expanded', 'true')
        const shown = await finding.locator('code').innerText()
        expect(shown).toBe('curl -N -H "Accept: text/event-stream" "$URL"')
        await finding.getByRole('button', { name: 'Copy', exact: true }).click()
        await expect(finding.getByRole('button', { name: 'Copied' })).toBeVisible()
        const clipboard = await readClipboard(page)
        expect(clipboard).toBe(shown)
        const secrets = R(['authorization', 'urlToken', 'urlApiKey'])
        expect(found(clipboard, secrets)).toEqual([])
        // the request that was made did carry them, as the server's log shows: the placeholder is not an accident of an empty request
        const conn = fx.groundTruth.connections.slice(before).find((c) => c.route === 'f04-silent')!
        expect(conn.requestHeaders['authorization']).toMatch(/^<present, \d+ characters>$/)
        expect(conn.query['token']).toBe(C['urlToken']!.value)
        expect(framesOf(conn)).toBeGreaterThan(0)
        expect((await healthStrip(page))['Connection']?.value).toBe('open')
        expect(await findingKeys(page)).toContain('stall.silent:bytes')
    })
})
