// Runs the scenario files in scenarios/ci with the BUILT CLI and checks each folder gets the verdict its name promises:
//   pass/          every scenario passes (exit 0); the JUnit file for these is written to dist-cli/scenarios-junit.xml
//   fail/          every scenario fails (exit 1), one file at a time, so a regression in a check cannot hide behind the others
//   inconclusive/  every scenario is inconclusive (exit 4)
// Run after `npm run build:cli`.

import { spawnSync } from 'node:child_process'
import { readdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const bin = path.join(root, 'dist-cli', 'bin', 'sse-doctor.mjs')
const base = path.join(root, 'scenarios', 'ci')
const run = (args) => spawnSync(process.execPath, [bin, ...args], { encoding: 'utf8', cwd: root })
const files = (dir) => readdirSync(path.join(base, dir)).filter((f) => f.endsWith('.json')).map((f) => path.join('scenarios', 'ci', dir, f))

const failures = []
const expect = (label, result, code) => {
    if (result.status !== code) failures.push(`${label}: exit ${result.status}, expected ${code}\n${result.stdout}${result.stderr}`)
}

const pass = files('pass')
const passed = run(['test', ...pass, '--format', 'junit'])
expect('pass/', passed, 0)
writeFileSync(path.join(root, 'dist-cli', 'scenarios-junit.xml'), passed.stdout)
for (const file of files('fail')) expect(file, run(['test', file]), 1)
for (const file of files('inconclusive')) {
    expect(file, run(['test', file]), 4)
    expect(`${file} with --allow-inconclusive`, run(['test', file, '--allow-inconclusive']), 0)
}

if (failures.length > 0) {
    console.error('doctor:scenarios FAILED')
    for (const f of failures) console.error(`  - ${f}`)
    process.exit(1)
}
console.log(`doctor:scenarios passed (${pass.length} passing, ${files('fail').length} failing as expected, ${files('inconclusive').length} inconclusive as expected)`)
