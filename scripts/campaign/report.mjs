// Campaign J3: a results report for a build, in the shape of the plan's template, made from facts collected on the machine and from result files
// the test runs wrote. It runs nothing itself: pass what the runs produced.
//
//   node scripts/campaign/report.mjs [--vitest vitest.json] [--playwright playwright.json] [--flake flake.json] [--out report.md]
//
// vitest: `npx vitest run --reporter=json --outputFile=vitest.json`. playwright: `npx playwright test --reporter=json > playwright.json`.
// What is not given is reported as "not run", never as passed.

import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const arg = (name) => { const i = process.argv.indexOf(`--${name}`); return i > 0 ? process.argv[i + 1] : undefined }
const root = path.resolve(import.meta.dirname, '..', '..')
const sh = (cmd, args, shell = false) => { try { return execFileSync(cmd, args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], shell }).trim() } catch { return 'unknown' } }
const json = (file) => (file && existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : undefined)

const commit = sh('git', ['rev-parse', 'HEAD'])
const porcelain = sh('git', ['status', '--porcelain'])
const tree = porcelain === '' ? 'clean' : porcelain === 'unknown' ? 'unknown' : `NOT clean (${porcelain.split('\n').length} paths)`

const vitest = json(arg('vitest'))
const playwright = json(arg('playwright'))
const flake = json(arg('flake'))

function vitestRows() {
    if (!vitest) return '| unit, property, integration (vitest) | not run |\n'
    const t = vitest.testResults.flatMap((f) => f.assertionResults)
    const by = (s) => t.filter((x) => x.status === s).length
    return `| unit, property, integration (vitest) | ${t.length} | ${by('passed')} | ${by('failed')} | ${by('pending') + by('skipped')} | ${vitest.numTotalTestSuites !== undefined ? `${vitest.testResults.length} files` : ''} |\n`
}
function playwrightRow() {
    if (!playwright) return '| browser (Playwright) | not run |\n'
    const s = playwright.stats ?? {}
    return `| browser (Playwright) | ${(s.expected ?? 0) + (s.unexpected ?? 0) + (s.flaky ?? 0) + (s.skipped ?? 0)} | ${s.expected ?? 0} | ${s.unexpected ?? 0} | ${s.skipped ?? 0} | flaky (passed on retry): ${s.flaky ?? 0} |\n`
}

const limitations = existsSync(path.join(root, 'docs/technical/limitations.md'))
    ? readFileSync(path.join(root, 'docs/technical/limitations.md'), 'utf8').split(/\r?\n/).filter((l) => /^## /.test(l)).map((l) => `- ${l.replace(/^## \d+\.\s*/, '')}`).join('\n')
    : '- (docs/technical/limitations.md not found)'

const report = `# Results report

Commit: ${commit}   Tree: ${tree}
Node: ${process.version}   npm: ${sh('npm', ['--version'], true)}   OS: ${os.type()} ${os.release()} (${os.arch()})   CPUs: ${os.cpus().length} x ${os.cpus()[0]?.model ?? 'unknown'}   RAM: ${(os.totalmem() / 2 ** 30).toFixed(1)} GiB
Date (UTC): ${new Date().toISOString()}

| Layer | run | pass | fail | skipped | notes |
|---|---|---|---|---|---|
${vitestRows()}${playwrightRow()}
Healthy-twin false positives and flakes under load: ${flake ? `${flake.runsWithFailures}/${flake.runs} runs had a failure, with ${flake.burners} busy processes${Object.keys(flake.failuresByTest).length ? ':\n' + Object.entries(flake.failuresByTest).map(([t, n]) => `  - ${n}x ${t}`).join('\n') : ''}` : 'not run'}

Known limitations in this build (headings of docs/technical/limitations.md; the campaign page docs/technical/testing-campaign.md lists what is open and what is not covered):
${limitations}

Verdict: ${vitest && vitest.numFailedTests === 0 && (!playwright || (playwright.stats?.unexpected ?? 0) === 0) && (!flake || flake.runsWithFailures === 0) ? 'PASS for what was run (anything marked "not run" above was not judged)' : 'NOT PASS, or not enough was run to say'}
`

const out = arg('out')
if (out) writeFileSync(out, report)
else process.stdout.write(report)
