import { spawn } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import type { Page } from '@playwright/test'
import { expect } from '@playwright/test'
import type { NormalisedFinding } from '../../src/core/testing/normalise'
import { withoutChunkEvidence } from '../../src/core/testing/normalise'

// Shared by e2e/journey.spec.ts (slice I). The journey's browser half and its command line half share files: every file a step
// produces is written under test-results/journey/<run>/ and the next step reads it from there, so the command line works on what a
// person would have downloaded, not on something the test rebuilt.

const ROOT = process.cwd()
export const BIN = path.join(ROOT, 'dist-cli', 'bin', 'sse-doctor.mjs')

/** A fresh folder for this run's files. */
export function journeyFolder(): string {
    const stamp = new Date().toISOString().replace(/[:.]/g, '-')
    const dir = path.join(ROOT, 'test-results', 'journey', `${stamp}-${process.pid}`)
    fs.mkdirSync(dir, { recursive: true })
    return dir
}

/** The test runner sets FORCE_COLOR for its workers; with NO_COLOR also set, Node prints a warning on stderr, which is not what the command line wrote. */
function childEnv(extra: Record<string, string> = {}): NodeJS.ProcessEnv {
    const env: NodeJS.ProcessEnv = { ...process.env, NO_COLOR: '1', ...extra }
    delete env['FORCE_COLOR']
    return env
}

export interface CliResult { code: number | null; stdout: string; stderr: string; killed: boolean; ms: number }

/** Runs the built command line as a process (the same way scripts/cli-contract.mjs does). Kills it, and says so, if it outlives `limitMs`. */
export function cli(args: string[], options: { env?: Record<string, string>; limitMs?: number } = {}): Promise<CliResult> {
    if (!fs.existsSync(BIN)) throw new Error(`${BIN} does not exist. Run "npm run build:cli" first.`)
    return new Promise((resolve) => {
        const started = Date.now()
        const child = spawn(process.execPath, [BIN, ...args], { cwd: ROOT, env: childEnv(options.env), stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true })
        let stdout = ''
        let stderr = ''
        let killed = false
        child.stdout.on('data', (d) => { stdout += d })
        child.stderr.on('data', (d) => { stderr += d })
        const timer = setTimeout(() => { killed = true; child.kill('SIGKILL') }, options.limitMs ?? 90_000)
        child.on('close', (code) => { clearTimeout(timer); resolve({ code, stdout, stderr, killed, ms: Date.now() - started }) })
    })
}

export interface Replay { url: string; stop(): Promise<void> }

/** `sse-doctor replay <capture>` as a process; resolves when it has printed the address it serves on. */
export function startReplay(capturePath: string, extra: string[] = []): Promise<Replay> {
    if (!fs.existsSync(BIN)) throw new Error(`${BIN} does not exist. Run "npm run build:cli" first.`)
    return new Promise((resolve, reject) => {
        const child = spawn(process.execPath, [BIN, 'replay', capturePath, ...extra], { cwd: ROOT, env: childEnv(), stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true })
        let stdout = ''
        let stderr = ''
        const closed = new Promise<void>((done) => { child.on('close', () => done()) })
        const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error(`replay did not print its address: ${stdout} ${stderr}`)) }, 20_000)
        child.stderr.on('data', (d) => { stderr += d })
        child.stdout.on('data', (d) => {
            stdout += d
            const m = /(http:\/\/127\.0\.0\.1:\d+\/)/.exec(stdout)
            if (!m) return
            clearTimeout(timer)
            resolve({ url: m[1]!, stop: async () => { child.kill('SIGKILL'); await closed } })
        })
        child.on('error', (e) => { clearTimeout(timer); reject(e) })
        child.on('close', (code) => { clearTimeout(timer); reject(new Error(`replay exited (${code}) before it served: ${stdout} ${stderr}`)) })
    })
}

/** Opens the export dialog of the open Doctor, chooses one kind, takes the one download this page makes, and saves it under `target`. */
export async function exportTo(page: Page, label: RegExp, target: string): Promise<{ name: string; bytes: Buffer }> {
    await page.getByTestId('doctor-export').click()
    await expect(page.getByTestId('export-dialog')).toBeVisible()
    await page.getByLabel(label).check()
    // the preview of the chosen kind is on screen before the button is used
    await expect(page.getByTestId('export-dialog').getByLabel(/Preview of/)).toBeVisible()
    const ack = page.getByTestId('export-ack')
    if (await ack.count()) await ack.check()
    const [file] = await Promise.all([page.waitForEvent('download'), page.getByTestId('export-download').click()])
    await file.saveAs(target)
    return { name: file.suggestedFilename(), bytes: fs.readFileSync(target) }
}

// ---------------------------------------------------------------------------------------------------------------- the D1 comparison policy
// A copy of the policy in src/fixtures/__tests__/roundTrip.test.ts (the plan's D1): that file is a test and cannot be imported from here.
// Class A: decided by the content of the stream, must be equal, evidence included. Class B: decided by timing or by how the bytes were cut
// up: the same key, rule, severity and status, occurrences within one, the same kinds of evidence. Class C: cannot be reproduced by a
// replay, left out.

type Klass = 'A' | 'B' | 'C'
const BY_RULE: Record<string, Klass> = {
    'proto.content-type': 'A', 'proto.framing': 'A', 'proto.headers-hints': 'C', 'timing.first-event': 'B', 'stall.silent': 'B',
    'delivery.bursty': 'B', 'reconnect.loop': 'A', 'resume.last-event-id': 'A', 'seq.integrity': 'A', 'heartbeat.recognition': 'B',
    'consumer.slow': 'C', 'security.credentials-in-metadata': 'C', 'proxy.masking': 'B', 'clock.discontinuity': 'C', 'schema.drift': 'A',
}
const BY_KEY: Record<string, Klass> = { 'reconnect.duration-pattern': 'B' }

function klassOf(n: NormalisedFinding): Klass {
    const byKey = BY_KEY[n.key] ?? BY_KEY[n.key.split(':')[0]!]
    if (byKey) return byKey
    const rule = BY_RULE[n.ruleId]
    if (!rule) throw new Error(`no replay policy for rule "${n.ruleId}" (finding ${n.key}): add it to BY_RULE in journeyKit.ts, with a class`)
    return rule
}

/** Everything the policy says differs between two normalised runs, as sentences. Empty when they agree. */
export function compareRuns(expected: NormalisedFinding[], actual: NormalisedFinding[]): { problems: string[]; excluded: string[] } {
    const problems: string[] = []
    const excluded: string[] = []
    const keep = (list: NormalisedFinding[]) => list.filter((n) => { if (klassOf(n) === 'C') { excluded.push(n.key); return false } return true })
    const want = new Map(keep(expected).map((n) => [n.key, n]))
    const got = new Map(keep(actual).map((n) => [n.key, n]))
    for (const key of want.keys()) if (!got.has(key)) problems.push(`missing: ${key}`)
    for (const key of got.keys()) if (!want.has(key)) problems.push(`extra: ${key}`)
    for (const [key, a] of want) {
        const b = got.get(key)
        if (!b) continue
        if (klassOf(a) === 'A') {
            if (JSON.stringify(a) !== JSON.stringify(b)) problems.push(`${key} differs (class A, must be equal):\n  expected ${JSON.stringify(a)}\n  actual   ${JSON.stringify(b)}`)
            continue
        }
        if (a.ruleId !== b.ruleId) problems.push(`${key}: rule ${a.ruleId} became ${b.ruleId}`)
        if (a.severity !== b.severity) problems.push(`${key}: severity ${a.severity} became ${b.severity}`)
        if (a.status !== b.status) problems.push(`${key}: status ${a.status} became ${b.status}`)
        if (Math.abs(a.occurrences - b.occurrences) > 1) problems.push(`${key}: occurrences ${a.occurrences} became ${b.occurrences} (class B allows one)`)
        // Differs from roundTrip.test.ts in one respect: a phase record is not compared. A probe ends its own connection when its time is up, which the
        // stall finding reports as one more fact ("the connection then ended"), with the phase change as its evidence; the capture it is compared with
        // was still open at its end.
        const kinds = (n: NormalisedFinding) => [...new Set(withoutChunkEvidence(n).evidence.filter((e) => e.kind !== 'phase').map((e) => e.kind))].sort().join(',')
        if (kinds(a) !== kinds(b)) problems.push(`${key}: evidence kinds ${kinds(a)} became ${kinds(b)}`)
    }
    return { problems, excluded: [...new Set(excluded)] }
}

/** What two recordings of the same stream may differ in no more than: a finding's identity and verdict, with every measured number left out. */
export const verdictOf = (list: Array<{ key: string; ruleId: string; ruleVersion: number; severity: string; status: string; deductions: Array<{ statement: string; confidence: string; alternatives: string[] }> }>, mask: (s: string) => string) =>
    list.map((f) => ({
        key: f.key, ruleId: f.ruleId, ruleVersion: f.ruleVersion, severity: f.severity, status: f.status,
        deductions: f.deductions.map((d) => ({ statement: mask(d.statement), confidence: d.confidence, alternatives: d.alternatives.map(mask).sort() })),
    })).sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0))

/** 95th percentile, nearest rank. */
export function p95(values: number[]): number {
    const s = [...values].sort((a, b) => a - b)
    return s[Math.min(s.length - 1, Math.ceil(0.95 * s.length) - 1)] ?? 0
}
