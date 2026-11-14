// Campaign J5: run the fixture suite many times while the machine is busy, and count what fails. A healthy twin that raises a finding only when the
// machine is slow is a false positive that users will meet on a loaded laptop; one run on a quiet machine never shows it.
//
//   node scripts/campaign/flake-loop.mjs [--runs 50] [--burners 2] [--out flake.json]
//
// Each run is `npx vitest run src/fixtures --maxWorkers=2 --reporter=json`. `--burners` busy-loop processes keep the CPUs occupied for the whole
// time. Prints "false positives on healthy twins: k/N" and writes the failures by test name. Exit 1 if any run failed.

import { spawn } from 'node:child_process'
import { writeFileSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const arg = (name, fallback) => { const i = process.argv.indexOf(`--${name}`); return i > 0 ? process.argv[i + 1] : fallback }
const RUNS = Number(arg('runs', '50'))
const BURNERS = Number(arg('burners', '2'))
const OUT = arg('out', '')
const root = path.resolve(import.meta.dirname, '..', '..')
const tmp = mkdtempSync(path.join(os.tmpdir(), 'flake-loop-'))

const burners = Array.from({ length: BURNERS }, () => spawn(process.execPath, ['-e', 'for(;;){}'], { stdio: 'ignore' }))
const stopBurners = () => { for (const b of burners) b.kill('SIGKILL') }
process.on('exit', stopBurners)
process.on('SIGINT', () => { stopBurners(); process.exit(130) })

const run = (i) => new Promise((resolve) => {
    const file = path.join(tmp, `run-${i}.json`)
    const child = spawn(process.execPath, [path.join(root, 'node_modules', 'vitest', 'vitest.mjs'), 'run', 'src/fixtures', '--maxWorkers=2', '--reporter=json', `--outputFile=${file}`], { cwd: root, stdio: 'ignore' })
    child.on('close', (code) => {
        let failed = []
        try {
            const result = JSON.parse(readFileSync(file, 'utf8'))
            failed = result.testResults.flatMap((f) => f.assertionResults.filter((t) => t.status === 'failed').map((t) => `${path.basename(f.name)} > ${t.fullName}`))
        } catch { if (code !== 0) failed = ['(the run produced no result file)'] }
        resolve({ i, code, failed })
    })
})

const failures = []
for (let i = 1; i <= RUNS; i++) {
    const r = await run(i)
    if (r.failed.length > 0) failures.push(r)
    process.stdout.write(`run ${i}/${RUNS}: ${r.failed.length === 0 ? 'ok' : `${r.failed.length} failed`}\n`)
}
stopBurners()
rmSync(tmp, { recursive: true, force: true })

const byTest = new Map()
for (const f of failures) for (const t of f.failed) byTest.set(t, (byTest.get(t) ?? 0) + 1)
const summary = { runs: RUNS, burners: BURNERS, runsWithFailures: failures.length, failuresByTest: Object.fromEntries(byTest) }
console.log(`\nfalse positives and flakes under load: ${failures.length}/${RUNS} runs had a failure (${BURNERS} busy processes)`)
for (const [t, n] of byTest) console.log(`  ${n}x ${t}`)
if (OUT) writeFileSync(OUT, JSON.stringify(summary, null, 2) + '\n')
process.exit(failures.length === 0 ? 0 : 1)
