// @vitest-environment node
import { spawn, type ChildProcess } from 'node:child_process'
import fs from 'node:fs'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

// The live check of the hosted site (scripts/live-smoke.mjs, v2.0.0 release) found that the README and the docs link to pages WITHOUT ".html"
// (https://sse-observatory.vercel.app/docs/technical/limitations) and that the hosted site answered 404 for every one of them: VitePress writes
// limitations.html, and neither Vercel nor the Express server served a file without its extension. The documentation links are clean URLs, so the hosts
// must serve them: Vercel with "cleanUrls", the Express server (the Docker image and `npm start`) with static "extensions". The server test runs
// the real server.js over a small built site.

const root = process.cwd()
const read = (p: string): string => fs.readFileSync(path.join(root, p), 'utf8')

describe('the documentation links are clean URLs, so the hosts serve them without .html', () => {
    it('Vercel serves a .html file at its clean URL', () => {
        expect(JSON.parse(read('vercel.json')).cleanUrls).toBe(true)
    })

    it('VitePress writes its own links as clean URLs', () => {
        expect(read('docs/.vitepress/config.mts')).toMatch(/cleanUrls:\s*true/)
    })

    it('every link to the hosted documentation in the README and the docs points at a page that exists', () => {
        const pages = new Set<string>()
        const walk = (dir: string): void => {
            for (const entry of fs.readdirSync(path.join(root, dir), { withFileTypes: true })) {
                if (entry.name === '.vitepress' || entry.name === 'node_modules') continue
                const rel = `${dir}/${entry.name}`
                if (entry.isDirectory()) walk(rel)
                else if (entry.name.endsWith('.md')) pages.add(rel.replace(/^docs\//, '').replace(/\.md$/, '').replace(/(^|\/)index$/, '$1'))
            }
        }
        walk('docs')
        // files in docs/public are served as they are, at /docs/<their path>
        const walkPublic = (dir: string): void => {
            for (const entry of fs.readdirSync(path.join(root, dir), { withFileTypes: true })) {
                const rel = `${dir}/${entry.name}`
                if (entry.isDirectory()) walkPublic(rel)
                else pages.add(rel.replace(/^docs\/public\//, ''))
            }
        }
        walkPublic('docs/public')
        const files = ['README.md', ...[...pages].filter((p) => fs.existsSync(path.join(root, `docs/${p === '' || p.endsWith('/') ? `${p}index` : p}.md`))).map((p) => `docs/${p === '' || p.endsWith('/') ? `${p}index` : p}.md`)]
        const broken: string[] = []
        for (const file of files) {
            const text = read(file)
            for (const m of text.matchAll(/https:\/\/sse-observatory\.vercel\.app\/docs\/([A-Za-z0-9_\-./]*)/g)) {
                const target = m[1]!.replace(/\.html$/, '').replace(/\/$/, '')
                if (target !== '' && !pages.has(target)) broken.push(`${file}: /docs/${m[1]}`)
            }
        }
        expect(broken).toEqual([])
    })
})

describe('server.js serves the built documentation at clean URLs', () => {
    let server: ChildProcess
    let base = ''
    let site = ''
    const freePort = () => new Promise<number>((resolve) => {
        const s = net.createServer()
        s.listen(0, '127.0.0.1', () => { const { port } = s.address() as net.AddressInfo; s.close(() => resolve(port)) })
    })

    beforeAll(async () => {
        site = fs.mkdtempSync(path.join(os.tmpdir(), 'docs-site-'))
        fs.mkdirSync(path.join(site, 'dist', 'docs', 'guide'), { recursive: true })
        fs.writeFileSync(path.join(site, 'dist', 'index.html'), '<!doctype html><title>the app</title>')
        fs.writeFileSync(path.join(site, 'dist', 'docs', 'index.html'), '<!doctype html><title>docs home</title>')
        fs.writeFileSync(path.join(site, 'dist', 'docs', 'guide', 'cli.html'), '<!doctype html><title>the cli guide</title>')
        const port = await freePort()
        base = `http://127.0.0.1:${port}`
        server = spawn(process.execPath, [path.join(root, 'server.js')], { cwd: site, env: { ...process.env, NODE_ENV: 'production', PORT: String(port) }, stdio: 'ignore' })
        for (let i = 0; i < 200; i++) {
            try { await fetch(`${base}/healthz`); return } catch { await new Promise((r) => setTimeout(r, 250)) }
        }
        throw new Error('server.js did not start')
    }, 60_000)
    afterAll(() => { server?.kill() })

    const title = async (p: string): Promise<{ status: number; title: string }> => {
        const r = await fetch(`${base}${p}`)
        return { status: r.status, title: /<title>([^<]*)<\/title>/.exec(await r.text())?.[1] ?? '' }
    }

    it('a page without its extension is the page, not the app', async () => {
        expect(await title('/docs/guide/cli')).toEqual({ status: 200, title: 'the cli guide' })
    })

    it('the same page with its extension, the docs home and the app itself are unchanged', async () => {
        expect(await title('/docs/guide/cli.html')).toEqual({ status: 200, title: 'the cli guide' })
        expect(await title('/docs/')).toEqual({ status: 200, title: 'docs home' })
        expect(await title('/')).toEqual({ status: 200, title: 'the app' })
    })
})
