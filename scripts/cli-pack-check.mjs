// Verifies the PACKED artifact, not just the repo checkout: packs dist-cli, checks what would be published, installs the
// tarball into an empty directory and runs it from there. Run after `npm run build:cli`.

import { spawn, spawnSync } from 'node:child_process'
import http from 'node:http'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const dist = path.join(root, 'dist-cli')
const SIZE_BUDGET_BYTES = 400 * 1024
const ALLOWED = [/^package\.json$/, /^README\.md$/, /^LICENSE$/, /^index\.mjs$/, /^bin\/sse-doctor\.mjs$/, /^types\/.+\.d\.ts$/]

const failures = []
const check = (ok, message) => { if (!ok) failures.push(message) }

// npm is a .cmd shim on Windows, which needs a shell.
const npm = (args, cwd) => spawnSync('npm', args, { cwd, encoding: 'utf8', shell: process.platform === 'win32' })

const scratch = mkdtempSync(path.join(tmpdir(), 'sse-doctor-pack-'))
try {
    const manifest = JSON.parse(readFileSync(path.join(dist, 'package.json'), 'utf8'))
    check(!manifest.dependencies || Object.keys(manifest.dependencies).length === 0, 'the package must have no dependencies (everything is bundled)')
    check(manifest.private !== true, 'dist-cli/package.json must not be private (it is generated to be publishable)')
    check(typeof manifest.scripts?.prepublishOnly === 'string', 'prepublishOnly guard is missing')
    check(readFileSync(path.join(dist, 'bin/sse-doctor.mjs'), 'utf8').startsWith('#!/usr/bin/env node'), 'bin/sse-doctor.mjs has no shebang')

    const pack = npm(['pack', '--json', '--pack-destination', scratch], dist)
    if (pack.status !== 0) throw new Error(`npm pack failed:\n${pack.stderr}`)
    const [info] = JSON.parse(pack.stdout)
    for (const file of info.files) check(ALLOWED.some((pattern) => pattern.test(file.path)), `unexpected file in the package: ${file.path}`)
    check(info.size <= SIZE_BUDGET_BYTES, `package is ${info.size} bytes (budget ${SIZE_BUDGET_BYTES})`)

    // Install the real tarball into an empty project and run it from there.
    const project = path.join(scratch, 'consumer')
    mkdirSync(project)
    writeFileSync(path.join(project, 'package.json'), JSON.stringify({ name: 'consumer', private: true }))
    const install = npm(['install', path.join(scratch, info.filename), '--no-audit', '--no-fund', '--loglevel=error'], project)
    if (install.status !== 0) throw new Error(`npm install of the tarball failed:\n${install.stderr}`)
    const bin = path.join(project, 'node_modules', manifest.name, 'bin/sse-doctor.mjs')

    const run = (args) => spawnSync(process.execPath, [bin, ...args], { encoding: 'utf8' })
    const version = run(['--version'])
    check(version.status === 0 && version.stdout.trim() === manifest.version, `--version printed "${version.stdout.trim()}", expected ${manifest.version}`)
    const selftest = run(['selftest'])
    check(selftest.status === 0 && selftest.stdout.includes('selftest passed'), `selftest from the installed package failed:\n${selftest.stdout}${selftest.stderr}`)

    // End to end: probe a local stream with secrets in the environment. They must reach the server and appear nowhere else.
    const canaries = { token: 'canary-pack-token-5d1e', auth: 'canary-pack-auth-83bc' }
    const seen = { query: false, auth: false }
    const server = http.createServer((req, res) => {
        seen.query = String(req.url).includes(canaries.token)
        seen.auth = req.headers.authorization === `Bearer ${canaries.auth}`
        res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' })
        let n = 0
        const timer = setInterval(() => {
            n++
            res.write(`id: ${n}\ndata: {"n":${n},"echo":"${canaries.token}"}\n\n`)
            if (n >= 3) { clearInterval(timer); res.end('event: end\ndata: done\n\n') }
        }, 30)
        res.on('close', () => clearInterval(timer))
    })
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
    try {
        const url = `http://127.0.0.1:${server.address().port}/stream`
        const outFile = path.join(scratch, 'probe.sse-capture')
        const probe = await new Promise((resolve) => {
            const child = spawn(process.execPath, [bin, 'probe', url, '--query-env', 'token=PACK_TOKEN', '--auth-env', 'PACK_AUTH', '--duration', '10', '--out', outFile], { env: { ...process.env, PACK_TOKEN: canaries.token, PACK_AUTH: canaries.auth } })
            let out = ''
            child.stdout.on('data', (d) => { out += d })
            child.stderr.on('data', (d) => { out += d })
            child.on('close', (code) => resolve({ code, out }))
        })
        check(probe.code === 0 || probe.code === 1, `probe exited ${probe.code}:\n${probe.out}`)
        check(seen.query && seen.auth, 'the secrets did not reach the server')
        const file = readFileSync(outFile, 'utf8')
        for (const [name, value] of Object.entries(canaries)) {
            check(!probe.out.includes(value), `the ${name} secret appeared in probe output`)
            check(!file.includes(value), `the ${name} secret was written to the capture file`)
        }
        const analyze = run(['analyze', outFile])
        check(analyze.status === 0 || analyze.status === 1, `analyze of the probe capture exited ${analyze.status}:\n${analyze.stdout}${analyze.stderr}`)
    } finally {
        server.closeAllConnections()
        server.close()
    }
} catch (error) {
    failures.push(error instanceof Error ? error.message : String(error))
} finally {
    rmSync(scratch, { recursive: true, force: true })
}

if (failures.length > 0) {
    console.error('cli:check FAILED')
    for (const failure of failures) console.error(`  - ${failure}`)
    process.exit(1)
}
console.log('cli:check passed (packed, installed into a clean directory, --version, selftest and a probe with secrets ran)')
