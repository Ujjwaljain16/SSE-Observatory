// Verifies the PACKED artifact, not just the repo checkout: packs dist-cli, checks what would be published, installs the
// tarball into an empty directory and runs it from there. Run after `npm run build:cli`.

import { spawnSync } from 'node:child_process'
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
console.log('cli:check passed (packed, installed into a clean directory, --version and selftest ran)')
