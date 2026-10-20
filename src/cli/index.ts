// sse-doctor entry point. `main` takes argv and an io object instead of touching process.*, so the whole CLI can be
// tested in-process (see __tests__). bin.ts is the thin Node wrapper.

import { parseArgs } from './args'
import { analyzeCommand, compareCommand, curlCommand, probeCommand, redactCommand, reportCommand } from './commands'
import { CliError, EXIT, type CliIo } from './io'
import { SecretRegistry, scrubbedIo } from './secretRegistry'
import { selftestChecks } from './selftest'

export { EXIT } from './io'
export type { CliIo } from './io'

/** Injected by scripts/build-cli.mjs at bundle time; undefined when running from source (tests). */
declare const __VERSION__: string | undefined

export const version = (): string => (typeof __VERSION__ === 'undefined' ? 'dev' : __VERSION__)

const HELP = `sse-doctor ${version()}

Usage: sse-doctor <command> [options]

Commands:
  probe <url>            connect, watch the stream, analyze it and print the findings
  analyze <capture>      analyze a saved capture (.sse-capture, or an old .sse-record)
  report <capture>       write a shareable report (md, html or json); needs a redacted capture
  compare <a> <b>        compare two saved captures
  curl <capture|url>     print a curl command that reproduces the request, with secrets as variables
  redact <capture>       write a copy that is safe to share (--output <file>)
  selftest               check that this build of the tool works
  --version, --help

Options:
  --format human|json|md|junit   how to print findings (default human)
  --output <file>                write to a file (report, redact)
  --fail-on <severity>           exit 1 when an open finding is at least this severe (default error)
  --profile <file.json>          a stream profile: sequence contract, delivery, expected cadence
  --quiet, --verbose, --no-color

probe options:
  --duration <s>  --max-events <n>  --idle-timeout <s>   when to stop (default 30 s)
  --out <file>                    save the capture (redacted unless --no-redact)
  --auth-env VAR                  send Authorization: Bearer $VAR
  --header-env Name=VAR           send a header from an environment variable (repeatable)
  --query-env param=VAR           add a query parameter from an environment variable (repeatable)
  --cookie-env VAR                send a Cookie header from an environment variable
  Secrets belong in environment variables. Every value is scrubbed from all output.

Exit codes: 0 passed, 1 findings at or above --fail-on, 2 usage error, 3 could not run, 4 inconclusive, 130 interrupted.
`

async function selftest(io: CliIo): Promise<number> {
    let failed = 0
    for (const check of selftestChecks()) {
        const problem = check.run()
        if (problem === null) io.out(`ok   ${check.name}\n`)
        else { failed++; io.err(`FAIL ${check.name}: ${problem}\n`) }
    }
    io.out(failed === 0 ? 'selftest passed\n' : `selftest failed (${failed})\n`)
    return failed === 0 ? EXIT.ok : EXIT.gateFailed
}

export async function main(argv: string[], rawIo: CliIo): Promise<number> {
    const secrets = new SecretRegistry()
    const io = scrubbedIo(rawIo, secrets)
    try {
        if (argv.includes('--version') || argv.includes('-v')) { io.out(`${version()}\n`); return EXIT.ok }
        if (argv.length === 0 || argv.includes('--help') || argv.includes('-h') || argv[0] === 'help') { io.out(HELP); return EXIT.ok }
        const args = parseArgs(argv)
        const command = args.positionals[0]
        switch (command) {
            case 'selftest': return await selftest(io)
            case 'analyze': return await analyzeCommand(io, args)
            case 'report': return await reportCommand(io, args)
            case 'redact': return await redactCommand(io, args)
            case 'compare': return await compareCommand(io, args)
            case 'curl': return await curlCommand(io, args)
            case 'probe': return await probeCommand(io, args, secrets)
            default:
                io.err(`Unknown command: ${command}\nRun "sse-doctor --help" for usage.\n`)
                return EXIT.usage
        }
    } catch (error) {
        if (error instanceof CliError) { io.err(`${error.message}\n`); return error.exit }
        io.err(`sse-doctor could not finish: ${error instanceof Error ? error.message : String(error)}\n`)
        return EXIT.couldNotRun
    }
}
