// @vitest-environment node
import fs from 'node:fs'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import Ajv2020 from 'ajv/dist/2020'
import { main, type CliIo } from '../index'
import { startFixtureServer, type FixtureServer } from '../../fixtures/server'

// Campaign F5: what the command line prints with --format json is a contract that CI scripts parse, so it has a published schema
// (docs/public/schemas/sse-cli-output-1.json and sse-test-output-1.json). This runs the real commands and validates what they print against those
// files, and shows that the schemas reject a damaged output (a schema that accepts anything proves nothing).

const schemaFile = (name: string): Record<string, unknown> => JSON.parse(fs.readFileSync(path.resolve(process.cwd(), 'docs/public/schemas', name), 'utf8')) as Record<string, unknown>
const ajv = new Ajv2020({ allErrors: true, strict: false })
const validateFindings = ajv.compile(schemaFile('sse-cli-output-1.json'))
const validateTest = ajv.compile(schemaFile('sse-test-output-1.json'))
const errorsOf = (v: { errors?: unknown }): string => JSON.stringify(v.errors ?? [])

let fixtures: FixtureServer
beforeAll(async () => { fixtures = await startFixtureServer({ port: 0 }) })
afterAll(async () => { await fixtures.close() })

const lab = (id: string) => fs.readFileSync(path.resolve(process.cwd(), `public/lab/${id}.sse-capture`), 'utf8')

async function run(argv: string[], files: Record<string, string> = {}): Promise<{ code: number; out: string }> {
    let out = ''
    const io: CliIo = { out: (t) => { out += t }, err: () => {}, env: {}, readText: async (p) => { if (p in files) return files[p]!; throw new Error('ENOENT') }, writeText: async () => {} }
    const code = await main(argv, io)
    return { code, out }
}

describe('F5: what --format json prints matches its published schema', () => {
    const LAB = ['h01', 'f04-silent', 'f04-heartbeats', 'f06-skips', 'f05-drops', 'f01-text-html', 'f09-buffered', 'f11-drift']
    for (const id of LAB) {
        it(`analyze of ${id}`, async () => {
            const r = await run(['analyze', 'x.sse-capture', '--format', 'json'], { 'x.sse-capture': lab(id) })
            const json = JSON.parse(r.out) as unknown
            expect(validateFindings(json), errorsOf(validateFindings)).toBe(true)
        })
    }

    it('analyze finds at least one finding with facts, a deduction and a next check somewhere in the set (the schema is exercised, not just empty arrays)', async () => {
        let withEverything = 0
        for (const id of LAB) {
            const r = await run(['analyze', 'x.sse-capture', '--format', 'json'], { 'x.sse-capture': lab(id) })
            const j = JSON.parse(r.out) as { findings: Array<{ facts: unknown[]; deductions: unknown[]; nextCheck?: unknown }> }
            if (j.findings.some((f) => f.facts.length > 0 && f.deductions.length > 0 && f.nextCheck)) withEverything++
        }
        expect(withEverything).toBeGreaterThan(2)
    })

    it('compare of two captures', async () => {
        const r = await run(['compare', 'a.sse-capture', 'b.sse-capture', '--format', 'json'], { 'a.sse-capture': lab('f09-buffered'), 'b.sse-capture': lab('f09-healthy') })
        expect(validateFindings(JSON.parse(r.out)), errorsOf(validateFindings)).toBe(true)
        expect((JSON.parse(r.out) as { findings: unknown[] }).findings.length).toBeGreaterThan(0)
    })

    it('probe of a live stream', async () => {
        const r = await run(['probe', fixtures.urlFor('h01', { scale: 0.05, n: 3 }), '--duration', '3', '--max-events', '4', '--format', 'json'])
        expect(validateFindings(JSON.parse(r.out)), errorsOf(validateFindings)).toBe(true)
    })

    it('probe of a stream that does not answer still prints a valid document', async () => {
        const r = await run(['probe', 'http://127.0.0.1:1/x', '--duration', '2', '--format', 'json'])
        expect(r.code).toBe(3)
        expect(validateFindings(JSON.parse(r.out)), errorsOf(validateFindings)).toBe(true)
    })

    it('test, for a scenario that passes, one that fails and one that cannot judge', async () => {
        for (const [file, status] of [['scenarios/ci/pass/h01-steady.json', 'pass'], ['scenarios/ci/fail/f06-resume-skips.json', 'fail'], ['scenarios/ci/inconclusive/f06-no-contract.json', 'inconclusive']] as const) {
            const r = await run(['test', file, '--format', 'json'], { [file]: fs.readFileSync(path.resolve(process.cwd(), file), 'utf8') })
            const json = JSON.parse(r.out) as { scenarios: Array<{ status: string }> }
            expect(validateTest(json), `${file}: ${errorsOf(validateTest)}`).toBe(true)
            expect(json.scenarios[0]!.status).toBe(status)
        }
    }, 60_000)
})

describe('F5: the schemas can fail', () => {
    const good = async () => JSON.parse((await run(['analyze', 'x.sse-capture', '--format', 'json'], { 'x.sse-capture': lab('f04-silent') })).out) as Record<string, any> // eslint-disable-line @typescript-eslint/no-explicit-any

    it('rejects a document with a field removed, a wrong type, a value outside an enum, or a wrong version', async () => {
        const damage: Array<[string, (j: Record<string, any>) => void]> = [ // eslint-disable-line @typescript-eslint/no-explicit-any
            ['no findings array', (j) => { delete j['findings'] }],
            ['no coverage array', (j) => { delete j['coverage'] }],
            ['findings is not an array', (j) => { j['findings'] = {} }],
            ['a severity that does not exist', (j) => { j['findings'][0].severity = 'catastrophic' }],
            ['a status that does not exist', (j) => { j['findings'][0].status = 'maybe' }],
            ['a finding without its key', (j) => { delete j['findings'][0].key }],
            ['facts with no evidence array', (j) => { delete j['findings'][0].facts[0].evidence }],
            ['an evidence time that is text', (j) => { j['findings'][0].facts[0].evidence[0].t = 'soon' }],
            ['a deduction without alternatives', (j) => { delete j['findings'][0].deductions[0].alternatives }],
            ['a confidence that does not exist', (j) => { j['findings'][0].deductions[0].confidence = 'certain' }],
            ['coverage with a made-up status', (j) => { j['coverage'][0].status = 'skipped' }],
            ['a schema version of 2', (j) => { j['schemaVersion'] = 2 }],
        ]
        for (const [what, change] of damage) {
            const j = await good()
            expect(validateFindings(j), 'the undamaged document is valid').toBe(true)
            change(j)
            expect(validateFindings(j), `${what} must be rejected`).toBe(false)
        }
    })

    it('rejects a damaged test output', async () => {
        const file = 'scenarios/ci/pass/h01-steady.json'
        const j = JSON.parse((await run(['test', file, '--format', 'json'], { [file]: fs.readFileSync(path.resolve(process.cwd(), file), 'utf8') })).out) as Record<string, any> // eslint-disable-line @typescript-eslint/no-explicit-any
        expect(validateTest(j)).toBe(true)
        const bad = structuredClone(j)
        bad['scenarios'][0].status = 'green'
        expect(validateTest(bad)).toBe(false)
        const missing = structuredClone(j)
        delete missing['scenarios'][0].checks
        expect(validateTest(missing)).toBe(false)
    }, 30_000)

    it('the published files say their own address, so a tool can find them', () => {
        expect(schemaFile('sse-cli-output-1.json')['$id']).toBe('https://sse-observatory.vercel.app/docs/schemas/sse-cli-output-1.json')
        expect(schemaFile('sse-test-output-1.json')['$id']).toBe('https://sse-observatory.vercel.app/docs/schemas/sse-test-output-1.json')
    })
})
