import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { parseCapture, captureEndT } from '../../core/capture/format'
import { analyze } from '../../core/diagnostics/engine'
import { FIXTURE_ROUTES } from '../server'
import { checkExpectations } from '../../doctor/labCheck'

// The failure lab is a set of static captures (public/lab, made by `npm run lab:build`). This keeps it truthful: whenever a rule or a
// threshold changes, every capture in the lab must still show what its fixture says it shows, or the lab must be made again.

const dir = path.resolve(process.cwd(), 'public/lab')
interface Entry { id: string; family: string; title: string; description: string; expected: string[]; forbidden: string[]; healthyTwin: string | null; file: string; events: number; seconds: number; scale: number }
interface Index { schemaVersion: number; entries: Entry[]; skipped: Array<{ id: string; reason: string }> }
const index = JSON.parse(fs.readFileSync(path.join(dir, 'index.json'), 'utf8')) as Index

describe('the failure lab', () => {
    it('has every fixture, either shown or skipped with a reason: none is forgotten', () => {
        const accounted = new Set([...index.entries.map((e) => e.id), ...index.skipped.map((s) => s.id)])
        expect(FIXTURE_ROUTES.map((r) => r.id).filter((id) => !accounted.has(id))).toEqual([])
        for (const s of index.skipped) expect(s.reason.length, s.id).toBeGreaterThan(20)
        expect(index.entries.length).toBeGreaterThanOrEqual(20)
    })

    it('says what each entry expects exactly as the fixture declares it', () => {
        for (const e of index.entries) {
            const route = FIXTURE_ROUTES.find((r) => r.id === e.id)!
            expect({ expected: e.expected, forbidden: e.forbidden, twin: e.healthyTwin === null ? null : route.healthyTwin }).toEqual({ expected: route.expectedFindings, forbidden: route.forbiddenFindings, twin: e.healthyTwin === null ? null : route.healthyTwin })
            if (e.healthyTwin) expect(index.entries.some((x) => x.id === e.healthyTwin), `${e.id}'s twin is in the lab`).toBe(true)
        }
    })

    for (const entry of index.entries) {
        it(`${entry.id}: the Doctor, with its default thresholds, finds what it must and nothing it must not`, () => {
            const text = fs.readFileSync(path.join(dir, entry.file), 'utf8')
            const { capture, integrity } = parseCapture(text)
            expect(integrity, 'the file is byte-exact: its hash still matches (a checkout that changed line endings would break it)').toBe('ok')
            expect(capture.header.kind).toBe('sanitized')
            expect(JSON.stringify(capture.header.request)).not.toMatch(/127\.0\.0\.1|localhost/) // no local address in a shipped file
            const analysis = analyze(capture.records as never, { ...(capture.header.profile ? { profile: capture.header.profile } : {}), endT: captureEndT(capture) })
            const check = checkExpectations(analysis.findings.map((f) => f.key), entry.expected, entry.forbidden)
            expect(check.problems).toEqual([])
        })
    }

    it('is small: every file is under 40 KB, so the lab is cheap to ship', () => {
        for (const e of index.entries) expect(fs.statSync(path.join(dir, e.file)).size, e.id).toBeLessThan(40 * 1024)
    })
})
