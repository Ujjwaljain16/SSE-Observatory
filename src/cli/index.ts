// sse-doctor entry point. `main` takes argv and an output sink instead of touching process.*, so the whole CLI can be
// tested in-process (see __tests__/cli.test.ts). bin.ts is the thin Node wrapper.

import { SSEParser } from '../core/sse/sseParser'

/** Injected by scripts/build-cli.mjs at bundle time; undefined when running from source (tests). */
declare const __VERSION__: string | undefined

export interface CliIo {
    out(text: string): void
    err(text: string): void
}

/** Exit codes shared by every command (see docs/guide/cli-ci.md once it exists). */
export const EXIT = {
    ok: 0,
    gateFailed: 1,
    usage: 2,
    couldNotRun: 3,
    inconclusive: 4,
    interrupted: 130,
} as const

export const version = (): string => (typeof __VERSION__ === 'undefined' ? 'dev' : __VERSION__)

const HELP = `sse-doctor ${version()}

Usage: sse-doctor <command> [options]

Commands:
  selftest        check that this build of the tool works
  --version       print the version
  --help          print this help

More commands (probe, analyze, test, ...) arrive in later releases.
`

/** The checks behind `selftest`. Later phases add the fixture matrix; for now it proves the bundled core runs. */
function selftestChecks(): Array<{ name: string; run(): string | null }> {
    return [
        {
            name: 'SSE parser reads a frame split across chunks',
            run() {
                const seen: string[] = []
                const parser = new SSEParser({ onMessage: (m) => seen.push(`${m.event}:${m.data}:${m.id}`) })
                for (const piece of ['event: tick\nid: 7\nda', 'ta: hel', 'lo\n\n']) parser.feed(piece)
                return seen.length === 1 && seen[0] === 'tick:hello:7' ? null : `unexpected result ${JSON.stringify(seen)}`
            },
        },
    ]
}

export async function main(argv: string[], io: CliIo): Promise<number> {
    const [command] = argv
    if (command === undefined || command === '--help' || command === '-h' || command === 'help') {
        io.out(HELP)
        return EXIT.ok
    }
    if (command === '--version' || command === '-v') {
        io.out(`${version()}\n`)
        return EXIT.ok
    }
    if (command === 'selftest') {
        let failed = 0
        for (const check of selftestChecks()) {
            const problem = check.run()
            if (problem === null) io.out(`ok   ${check.name}\n`)
            else { failed++; io.err(`FAIL ${check.name}: ${problem}\n`) }
        }
        io.out(failed === 0 ? 'selftest passed\n' : `selftest failed (${failed})\n`)
        return failed === 0 ? EXIT.ok : EXIT.gateFailed
    }
    io.err(`Unknown command: ${command}\nRun "sse-doctor --help" for usage.\n`)
    return EXIT.usage
}
