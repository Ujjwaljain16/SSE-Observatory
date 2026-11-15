// Campaign D5: the limits docs/technical/limitations.md section 9 states, measured. "A 116 MB capture (1.2 million records) analyzes in about 24 s inside a
// 384 MB heap, and redaction handles 200,000 chunks with 200,000 secrets in about 4 s", and the mock upload refuses more than 20 MB. A documented number
// that nothing reproduces is a claim; this reproduces it. Run on a quiet machine, after `npm run build:cli`:
//
//   node scripts/perf/large-capture.mjs [--records 1200000] [--chunks 200000] [--heap 384]
//
// Exit 1 if analyze fails or takes more than 60 s in the heap given, redaction takes more than 15 s, or the oversized upload is not refused with 413.
// The thresholds are deliberately looser than the documented figures: they catch a collapse, and the printed times are what is compared with the docs.

import { build } from 'esbuild'
import { spawn } from 'node:child_process'
import { createWriteStream, existsSync, mkdtempSync, rmSync, statSync } from 'node:fs'
import { once } from 'node:events'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

const arg = (name, fallback) => { const i = process.argv.indexOf(`--${name}`); return i > 0 ? process.argv[i + 1] : fallback }
const RECORDS = Number(arg('records', '1200000'))
const CHUNKS = Number(arg('chunks', '200000'))
const HEAP_MB = Number(arg('heap', '384'))
const root = path.resolve(import.meta.dirname, '..', '..')
const BIN = path.join(root, 'dist-cli', 'bin', 'sse-doctor.mjs')
if (!existsSync(BIN)) { console.error('Run "npm run build:cli" first.'); process.exit(2) }

const tmp = mkdtempSync(path.join(os.tmpdir(), 'large-capture-'))
const failures = []
const check = (ok, what) => { console.log(`${ok ? 'ok  ' : 'FAIL'} ${what}`); if (!ok) failures.push(what) }

// ---- 1. a big capture file, written as a stream so making it needs no memory of its own
const file = path.join(tmp, 'big.sse-capture')
{
    const out = createWriteStream(file)
    const header = { format: 'sse-capture', version: '2.0', createdAt: new Date().toISOString(), kind: 'sanitized', tool: { name: 'large-capture', version: 'dev' }, source: { kind: 'fixture' }, clock: { origin: 'monotonic' }, capabilities: ['connect', 'response', 'chunks', 'events'] }
    const write = async (line) => { if (!out.write(line + '\n')) await once(out, 'drain') }
    await write(JSON.stringify(header))
    await write(JSON.stringify({ seq: 0, t: 0, conn: 0, kind: 'connect', attempt: 0, url: 'https://stream.test/e', method: 'GET', headerNames: ['accept'], sentLastEventId: '' }))
    await write(JSON.stringify({ seq: 1, t: 5, conn: 0, kind: 'response', status: 200, contentType: 'text/event-stream', redirected: false, headers: { 'content-type': 'text/event-stream' }, ttfbMs: 5 }))
    let seq = 2
    let id = 0
    while (seq < RECORDS) {
        id++
        const t = seq * 2
        await write(JSON.stringify({ seq: seq++, t, conn: 0, kind: 'chunk', bytes: 120, text: `id: ${id}\nevent: tick\ndata: {"n":${id},"price":9.5}\n\n` }))
        if (seq < RECORDS) await write(JSON.stringify({ seq: seq++, t, conn: 0, kind: 'event', event: 'tick', sseId: String(id), dataBytes: 24, dataHash: id.toString(16) }))
    }
    out.end()
    await once(out, 'finish')
}
const sizeMb = statSync(file).size / 1048576
console.log(`capture: ${RECORDS} records, ${sizeMb.toFixed(0)} MB\n`)

// ---- 2. analyze inside a small heap
{
    const start = Date.now()
    const r = await new Promise((resolve) => {
        const child = spawn(process.execPath, [`--max-old-space-size=${HEAP_MB}`, BIN, 'analyze', file, '--format', 'json'], { stdio: ['ignore', 'pipe', 'pipe'] })
        let out = 0
        let err = ''
        child.stdout.on('data', (d) => { out += d.length })
        child.stderr.on('data', (d) => { err += d })
        child.on('close', (code) => resolve({ code, out, err }))
    })
    const s = (Date.now() - start) / 1000
    console.log(`analyze in a ${HEAP_MB} MB heap: exit ${r.code}, ${s.toFixed(1)} s (docs: about 24 s)`)
    check(r.code === 0 || r.code === 1, `analyze finished (exit ${r.code})${r.code > 1 ? ': ' + r.err.slice(0, 160).replace(/\s+/g, ' ') : ''}`)
    check(s < 60, `analyze took ${s.toFixed(1)} s, under 60 s`)
}

// ---- 3. redaction of many chunks holding many different secrets
await build({ stdin: { contents: "export { redactCapture } from './src/core/capture/redact'\nexport { newHeader } from './src/core/capture/format'", resolveDir: root, loader: 'ts', sourcefile: 'entry.ts' }, bundle: true, platform: 'node', format: 'esm', outfile: path.join(tmp, 'redact.mjs'), logLevel: 'error', target: 'node20' })
{
    const { redactCapture, newHeader } = await import(pathToFileURL(path.join(tmp, 'redact.mjs')).href)
    const records = Array.from({ length: CHUNKS }, (_, i) => {
        const text = `data: {"user":"u${i}","password":"Secret${String(i).padStart(8, '0')}Zq"}\n\n`
        return { seq: i, t: i, conn: 0, kind: 'chunk', bytes: text.length, b64: Buffer.from(text).toString('base64') }
    })
    const capture = { header: newHeader({ kind: 'local-full', source: { kind: 'fixture' } }), records }
    const start = Date.now()
    const { report } = redactCapture(capture)
    const s = (Date.now() - start) / 1000
    console.log(`\nredaction of ${CHUNKS} chunks with ${CHUNKS} different secrets: ${s.toFixed(1)} s, ${report.placeholders} placeholders (docs: about 4 s)`)
    check(s < 15, `redaction took ${s.toFixed(1)} s, under 15 s`)
    check(report.placeholders >= CHUNKS, `every secret was replaced (${report.placeholders} placeholders)`)
}

// ---- 4. the mock upload refuses what is over its limit
{
    const { handleMockSession } = await import(pathToFileURL(path.join(root, 'lib', 'mock', 'handlers.js')).href)
    const { loadConfig } = await import(pathToFileURL(path.join(root, 'lib', 'proxy', 'guard.js')).href)
    const config = loadConfig({ NODE_ENV: 'development', ENABLE_MOCK_API: '1' })
    // the handler reads and counts the body itself when it is not given one (Vercel's path); the Express server enforces the same 20 MB in its body parser
    const server = http.createServer((req, res) => { void handleMockSession(req, res, { config }) })
    await new Promise((r) => server.listen(0, '127.0.0.1', r))
    const url = `http://127.0.0.1:${server.address().port}/api/mock/session`
    const over = 'x'.repeat(21 * 1048576)
    const res = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/x-ndjson' }, body: over }).catch((e) => ({ status: `error: ${e.message}` }))
    console.log(`\nmock upload of 21 MB (limit 20 MB): HTTP ${res.status}`)
    check(res.status === 413, `the upload over 20 MB is refused with 413 (got ${res.status})`)
    server.closeAllConnections?.()
    server.close()
}

rmSync(tmp, { recursive: true, force: true })
console.log(failures.length === 0 ? '\nAll limits held.' : `\n${failures.length} limit(s) did not hold.`)
process.exit(failures.length === 0 ? 0 : 1)
