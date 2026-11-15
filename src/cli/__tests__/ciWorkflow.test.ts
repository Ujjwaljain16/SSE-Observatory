// @vitest-environment node
import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

// Campaign J6: the checks that keep this project honest run in the CI workflow, and a workflow file is easy to edit by accident: a step deleted in a
// merge, a blocking job made informational, a script renamed. This reads the workflow files as text and holds the parts that matter, so losing one
// is a failing test instead of a quiet gap. (It does not run the workflow; actionlint would check the syntax, and is not installed here.)

const root = process.cwd()
const read = (p: string): string => fs.readFileSync(path.join(root, p), 'utf8').replace(/\r\n/g, '\n')
const ci = read('.github/workflows/ci.yml')
const pkg = JSON.parse(read('package.json')) as { scripts: Record<string, string>; engines?: { node?: string } }

/** The text of each job, by its key under `jobs:`. */
function jobs(text: string): Record<string, string> {
    const body = text.slice(text.indexOf('\njobs:\n') + 6)
    const out: Record<string, string> = {}
    const parts = body.split(/^  ([A-Za-z0-9_-]+):\n/m)
    for (let i = 1; i < parts.length; i += 2) out[parts[i]!] = parts[i + 1]!
    return out
}
const J = jobs(ci)
const runs = (job: string): string[] => [...(J[job] ?? '').matchAll(/^\s+- run: (.+)$/gm)].map((m) => m[1]!.trim())

describe('the CI workflow still holds what the project depends on', () => {
    it('has the jobs it is known by', () => {
        expect(Object.keys(J)).toEqual(expect.arrayContaining(['verify', 'audit', 'docker', 'e2e']))
    })

    it('verify runs, in this order, lint, typecheck, the tests with coverage, the build, the CLI build and every check of the built command line', () => {
        const steps = runs('verify')
        const required = ['npm run lint', 'npm run typecheck', 'npm run test:coverage', 'npm run build', 'npm run build:cli', 'npm run doctor:selftest', 'npm run doctor:buildcheck', 'npm run cli:check', 'npm run doctor:scenarios', 'npm run doctor:contract']
        for (const step of required) expect(steps, `verify is missing "${step}"`).toContain(step)
        const at = required.map((s) => steps.indexOf(s))
        expect([...at].sort((a, b) => a - b), 'the steps are in order').toEqual(at)
        // the built-CLI checks need the build before them
        expect(steps.indexOf('npm run build:cli')).toBeLessThan(steps.indexOf('npm run doctor:selftest'))
        // scenarios write a file into dist-cli, which the build check expects not to find: it must run before them
        expect(steps.indexOf('npm run doctor:buildcheck')).toBeLessThan(steps.indexOf('npm run doctor:scenarios'))
    })

    it('verify runs on Linux and on Windows', () => {
        expect(J['verify']).toMatch(/os: \[ubuntu-latest, windows-latest\]/)
        expect(J['verify']).toMatch(/fail-fast: false/)
    })

    it('verify also runs once on Node 20, the oldest the command line supports, and only one leg uploads the scenario results (two would collide)', () => {
        expect(J['verify']).toMatch(/include:\n\s+#[^\n]*\n\s+- os: ubuntu-latest\n\s+node: 20/)
        expect(J['verify']).toMatch(/node-version: \$\{\{ matrix\.node \}\}/)
        expect(J['verify']).toMatch(/matrix\.node == 22/)
        expect(pkg.engines?.node, 'the engines field and the oldest tested Node agree').toBe('>=20')
    })

    it('the dependency audit gates high and critical advisories in what ships', () => {
        expect(runs('audit')).toContain('npm audit --omit=dev --audit-level=high')
    })

    it('the browser tests on Chromium are blocking; Firefox and WebKit are informational and still there', () => {
        expect(runs('e2e').some((r) => /npm run test:e2e|playwright test/.test(r)), 'e2e runs Playwright').toBe(true)
        expect(J['e2e'], 'the Chromium job must not be allowed to fail').not.toMatch(/continue-on-error:\s*true/)
        const other = Object.keys(J).find((k) => /other-browsers/.test(k))
        expect(other, 'a Firefox/WebKit job exists').toBeDefined()
        expect(J[other!]).toMatch(/continue-on-error:\s*true/)
    })

    it('the Docker image is built and started', () => {
        expect(J['docker']).toMatch(/docker build/)
        expect(J['docker']).toMatch(/healthz/)
    })

    it('every npm script a workflow runs exists in package.json', () => {
        const workflows = fs.readdirSync(path.join(root, '.github/workflows')).filter((f) => /\.ya?ml$/.test(f))
        const missing: string[] = []
        for (const file of workflows) {
            for (const m of read(`.github/workflows/${file}`).matchAll(/npm run ([A-Za-z0-9:_-]+)/g)) if (!(m[1]! in pkg.scripts)) missing.push(`${file}: npm run ${m[1]}`)
        }
        expect(missing).toEqual([])
    })

    it('the scripts the workflow relies on still do what their name says', () => {
        expect(pkg.scripts['doctor:selftest']).toMatch(/sse-doctor\.mjs selftest/)
        expect(pkg.scripts['doctor:contract']).toMatch(/cli-contract\.mjs/)
        expect(pkg.scripts['doctor:buildcheck']).toMatch(/build-check\.mjs/)
        expect(pkg.scripts['doctor:scenarios']).toMatch(/run-ci-scenarios\.mjs/)
        expect(pkg.scripts['test:coverage']).toMatch(/vitest run --coverage/)
    })

    it('the workflow has no secrets in it and asks for read-only repository access', () => {
        expect(ci).toMatch(/permissions:\n  contents: read/)
        expect(ci).not.toMatch(/(password|token|secret)\s*[:=]\s*['"]?[A-Za-z0-9_\-]{16,}/i)
    })
})

describe('the nightly workflow', () => {
    const nightly = read('.github/workflows/nightly.yml')
    it('runs on a schedule and by hand, and asks for no more than it needs', () => {
        expect(nightly).toMatch(/schedule:\n\s+- cron:/)
        expect(nightly).toMatch(/workflow_dispatch:/)
        expect(nightly).toMatch(/permissions:\n  contents: read\n  issues: write/)
    })
    it('names only files and scripts that exist, so it cannot fail for a typo at 3 a.m.', () => {
        const missing: string[] = []
        for (const m of nightly.matchAll(/\b((?:scripts|src)\/[A-Za-z0-9_./-]+\.(?:mjs|ts))\b/g)) if (!fs.existsSync(path.join(root, m[1]!))) missing.push(m[1]!)
        expect(missing).toEqual([])
    })
    it('runs the real-time twins and the sensitivity check with NIGHTLY=1, the flake loop and the Node 20 suite', () => {
        expect(nightly).toMatch(/nightly\.twins\.test\.ts/)
        expect(nightly).toMatch(/fixtures\.sensitivity\.test\.ts/)
        expect(nightly).toMatch(/NIGHTLY: '1'/)
        expect(nightly).toMatch(/flake-loop\.mjs/)
        expect(nightly).toMatch(/node-version: 20/)
    })
    it('the tests it runs only when NIGHTLY=1 still check their own lists in every run', () => {
        for (const f of ['src/fixtures/__tests__/nightly.twins.test.ts', 'src/fixtures/__tests__/fixtures.sensitivity.test.ts']) {
            const text = read(f)
            expect(text, f).toMatch(/NIGHTLY/)
            expect(text, `${f} has a check that is not skipped`).toMatch(/describe\('the (nightly|sensitivity) list'/)
        }
    })
})

describe('the release-candidate workflow', () => {
    const rc = read('.github/workflows/release-candidate.yml')
    it('is run by hand, or by a pull request that changes the file itself, never on a schedule or a push; and changes nothing: it publishes, tags and deploys nothing', () => {
        expect(rc).toMatch(/on:\n  workflow_dispatch:/)
        expect(rc).toMatch(/pull_request:\n    paths:\n      - '\.github\/workflows\/release-candidate\.yml'/)
        expect(rc).not.toMatch(/\n  (schedule|push):/)
        expect(rc).toMatch(/permissions:\n  contents: read\n/)
        expect(rc, 'no publish, release or deploy step').not.toMatch(/npm publish|gh release|vercel (deploy|--prod)|git push|git tag/)
    })
    it('holds everything a pull request holds, on both systems and on Node 20, and the real-time and limits checks the nightly has', () => {
        for (const step of ['npm run lint', 'npm run typecheck', 'npm run test:coverage', 'npm run build', 'npm run build:cli', 'npm run doctor:selftest', 'npm run doctor:buildcheck', 'npm run cli:check', 'npm run doctor:scenarios', 'npm run doctor:contract', 'npm pack --dry-run', 'npm audit --omit=dev --audit-level=high', 'docker build', 'npm run test:e2e', 'large-capture.mjs']) expect(rc, step).toContain(step)
        expect(rc).toMatch(/os: \[ubuntu-latest, windows-latest\]/)
        expect(rc).toMatch(/node: 20/)
        for (const t of ['nightly.twins', 'fixtures.sensitivity', 'scaleInvariance', 'replayTiming']) expect(rc, t).toContain(t)
        expect(rc).toMatch(/NIGHTLY: '1'/)
    })
    it('the Chromium browser job blocks, the other browsers are informational', () => {
        const j = jobs(rc)
        expect(j['e2e']).not.toMatch(/continue-on-error:\s*true/)
        expect(j['other-browsers']).toMatch(/continue-on-error:\s*true/)
    })
    it('names only files and scripts that exist', () => {
        const missing: string[] = []
        for (const m of rc.matchAll(/\b((?:scripts|src)\/[A-Za-z0-9_./-]+\.(?:mjs|ts))\b/g)) if (!fs.existsSync(path.join(root, m[1]!))) missing.push(m[1]!)
        expect(missing).toEqual([])
    })
})

describe('the scenario action workflow', () => {
    const action = read('.github/workflows/action-test.yml')
    it('runs when the things it tests change, and can be run by hand', () => {
        for (const p of ["'action.yml'", "'scenarios/**'", "'src/cli/**'", "'src/fixtures/**'"]) expect(action, `its path filter has ${p}`).toContain(p)
        expect(action).toMatch(/workflow_dispatch:/)
    })
})
