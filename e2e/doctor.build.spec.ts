import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { test, expect } from '@playwright/test'
import { startFixtureServer, type FixtureServer } from '../src/fixtures/server'
import { connectDirect, download, findingKeys, openDoctor } from './support/doctorKit'

// G7: the build that users get, not the dev server. `vite build` writes to a temporary folder, a small static server serves it, and the Doctor is
// driven the way doctor.spec does: the badge, one finding, the lazily loaded export dialog and a download. What differs between the two builds is
// what this is for: minified code, split chunks, a worker bundled as its own file, and none of React's development behaviour.

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const TYPES: Record<string, string> = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon', '.woff2': 'font/woff2', '.map': 'application/json' }

let fx: FixtureServer
let site: http.Server
let siteUrl = ''
let outDir = ''

test.beforeAll(async () => {
    test.setTimeout(300_000)
    outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sse-build-'))
    execFileSync(process.execPath, [path.join(ROOT, 'node_modules', 'vite', 'bin', 'vite.js'), 'build', '--outDir', outDir, '--emptyOutDir'], { cwd: ROOT, stdio: 'pipe', timeout: 280_000 })
    site = http.createServer((req, res) => {
        const pathname = decodeURIComponent(new URL(req.url ?? '/', 'http://x').pathname)
        let file = path.join(outDir, pathname === '/' ? 'index.html' : pathname)
        if (!file.startsWith(outDir) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) file = path.join(outDir, 'index.html')
        res.writeHead(200, { 'Content-Type': TYPES[path.extname(file)] ?? 'application/octet-stream' })
        fs.createReadStream(file).pipe(res)
    })
    await new Promise<void>((resolve) => site.listen(0, '127.0.0.1', () => resolve()))
    siteUrl = `http://127.0.0.1:${(site.address() as AddressInfo).port}`
    fx = await startFixtureServer({ port: 0 })
})
test.afterAll(async () => {
    await fx?.close()
    site?.closeAllConnections()
    site?.close()
    if (outDir) fs.rmSync(outDir, { recursive: true, force: true })
})

test.describe('G7: the production build', () => {
    test('the badge, a finding, the export dialog (a chunk loaded on demand) and a download work on the built app', async ({ page }) => {
        test.setTimeout(120_000)
        const errors: string[] = []
        page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()) })
        page.on('pageerror', (e) => errors.push(e.message))
        const scripts: string[] = []
        page.on('response', (r) => { if (r.url().endsWith('.js')) scripts.push(path.basename(new URL(r.url()).pathname)) })

        await page.goto(siteUrl)
        // the built page is the minified production bundle, not the dev server's modules
        expect(await page.evaluate(() => Array.from(document.scripts).some((s) => s.src.includes('/@vite/') || s.src.includes('/src/')))).toBe(false)
        await connectDirect(page, fx.urlFor('f04-silent', { scale: 0.25 }))
        await expect(page.getByTestId('doctor-badge')).toBeVisible({ timeout: 40_000 })
        await openDoctor(page)
        await expect(page.locator('[data-finding-key="stall.silent:bytes"]')).toBeVisible()
        expect(await findingKeys(page)).toEqual(['stall.silent:bytes'])

        const before = scripts.length
        await page.getByTestId('doctor-export').click()
        await expect(page.getByTestId('export-dialog')).toBeVisible()
        expect(scripts.slice(before).length, 'the export dialog is a chunk fetched when it is opened').toBeGreaterThan(0)
        const file = await download(page)
        expect(file.name).toMatch(/\.report\.md$/)
        expect(file.text).toContain('# SSE Observatory report')
        expect(file.text).toContain('stall.silent:bytes')
        expect(errors, errors.join('\n')).toEqual([])
    })
})
