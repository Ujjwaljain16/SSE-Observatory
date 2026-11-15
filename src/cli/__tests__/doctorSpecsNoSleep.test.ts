// @vitest-environment node
import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

// Campaign G9: the Stream Doctor's browser specs never wait for a fixed time. A `waitForTimeout` is a guess about how long something takes; on a
// slow machine it is too short (the test fails for no reason) and on a fast one it is too long (the suite is slow), and when it stands in for
// "the stream has done enough that an absence means something" it is the kind of wait that lets a check pass because it looked too early. A
// test waits for a signal: the fixture server's own log, a test id, a live-region text, or an `expect.poll` on a condition.
//
// This test reads the files, so it needs no browser. It covers the Doctor's specs (`e2e/doctor*.spec.ts`) and the journey. The repository's older
// specs still have dozens of them; they are not covered here.

const E2E = path.resolve(__dirname, '../../../e2e')
const COVERED = /^(doctor.*|journey)\.spec\.ts$/

/** The lines of a source text that call `waitForTimeout`, as "line number: text". A comment that mentions it is not a call. */
export function sleeps(source: string): string[] {
    const found: string[] = []
    let inBlock = false
    source.split(/\r?\n/).forEach((line, i) => {
        let code = line
        if (inBlock) {
            const end = code.indexOf('*/')
            if (end < 0) return
            code = code.slice(end + 2)
            inBlock = false
        }
        code = code.replace(/\/\*.*?\*\//g, '')
        const open = code.indexOf('/*')
        if (open >= 0) { code = code.slice(0, open); inBlock = true }
        code = code.replace(/\/\/.*$/, '')
        if (/\bwaitForTimeout\b/.test(code)) found.push(`${i + 1}: ${line.trim()}`)
    })
    return found
}

describe('the Doctor specs do not wait for a fixed time (G9)', () => {
    const files = fs.readdirSync(E2E).filter((f) => COVERED.test(f)).sort()

    it('covers the specs it names', () => {
        expect(files).toContain('doctor.spec.ts')
        expect(files).toContain('journey.spec.ts')
    })

    for (const file of files) {
        it(`${file} has no waitForTimeout`, () => {
            expect(sleeps(fs.readFileSync(path.join(E2E, file), 'utf8')), `a fixed wait in e2e/${file}: wait for the page, the server's log or a test id instead`).toEqual([])
        })
    }

    describe('the detector', () => {
        it('finds a call, in any spelling of the object, and in CRLF text', () => {
            expect(sleeps("await page.waitForTimeout(400)\r\nawait frame.waitForTimeout(1)")).toHaveLength(2)
            expect(sleeps("  await page . waitForTimeout (400)")).toHaveLength(1)
        })
        it('does not take a comment for a call', () => {
            expect(sleeps("// never page.waitForTimeout(400)\n/* or waitForTimeout\n still a comment waitForTimeout */\nawait x() /* waitForTimeout */")).toEqual([])
        })
        it('finds a call on the line after a comment ends', () => {
            expect(sleeps("/* note\n*/ await page.waitForTimeout(5)")).toEqual(['2: */ await page.waitForTimeout(5)'])
        })
    })
})
