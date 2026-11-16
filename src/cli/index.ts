// sse-doctor entry point. `main` takes argv and an io object instead of touching process.*, so the whole CLI can be
// tested in-process (see __tests__). bin.ts is the thin Node wrapper.

import { parseArgs } from './args'
import { analyzeCommand, compareCommand, curlCommand, probeCommand, redactCommand, reportCommand, reproCommand } from './commands'
import { envDiffCommand } from './commandsEnvDiff'
import { validateCommand } from './commandsValidate'
import { fixturesCommand, replayCommand, testCommand } from './commandsScenario'
import { CliError, EXIT, type CliIo } from './io'
import { SecretRegistry, scrubbedIo } from './secretRegistry'
import { selftestChecks } from './selftest'
import { sanitizeText } from './sanitize'
import { toolVersion } from '../core/version'

export { EXIT } from './io'
export type { CliIo } from './io'

/** The package.json version, injected at bundle time by scripts/build-cli.mjs ('dev' only when running the source with no build). */
export const version = (): string => toolVersion()

const HELP = `sse-doctor ${version()}

Usage: sse-doctor <command> [options]

Commands:
  probe <url>            connect, watch the stream, analyze it and print the findings
  analyze <capture>      analyze a saved capture (.sse-capture, or an old .sse-record)
  report <capture>       write a shareable report (md, html, json, or issue for a ticket or pull request comment); needs a redacted capture
  compare <a> <b>        compare two saved captures
  validate <capture> <url> did the fix work? read the fixed stream the way the capture was read and say whether its finding is gone (exit 0 fixed, 1 not fixed, 4 inconclusive)
  env-diff <urlA> <urlB> read the same stream through two paths at once (origin and CDN, staging and production) and say where it differs
  repro <capture>        shrink a capture to the smallest one that still shows a finding (--finding key, --output, --scenario, --test)
  curl <capture|url>     print a curl command that reproduces the request, with secrets as variables
  redact <capture>       write a copy that is safe to share (--output <file>)
  test <scenario.json>.. run scenario files: collect, disconnect, reconnect, verify (exit 4 = inconclusive; --summary <file.md> also writes a Markdown summary)
  replay <capture>       serve a capture as a local SSE endpoint (--honor-last-event-id, --drop-after, --skip-ids)
  fixtures list|serve    the built-in faulty and healthy streams
  selftest               check that this build of the tool works
  --version, --help

Options:
  --format human|json|md|junit   how to print findings (default human)
  --output <file>                write to a file (report, redact)
  --fail-on <severity>           exit 1 when an open finding is at least this severe (default error)
  --profile <file.json>          a stream profile: sequence contract, delivery, expected cadence
  --redact-policy <file.json>    your own redaction rules on top of the built-in ones (redact, report, curl, repro, probe --out)
  --quiet, --verbose, --no-color

env-diff options: the probe options below apply to both sides; --label-a/--label-b name them, --out-a/--out-b save each capture,
  and --auth-env-a/-b, --cookie-env-a/-b, --header-env-a/-b, --query-env-a/-b give one side its own credentials.

probe options:
  --duration <s>  --max-events <n>  --idle-timeout <s>   when to stop (default 30 s)
  --out <file>                    save the capture (redacted unless --no-redact; --no-redact is refused when any secret option below is given)
  --follow-redirects              follow a redirect to another origin even though credentials are attached (without it that redirect is refused);
                                  the credentials are still never sent to the other origin, and a warning names the ones that were not forwarded.
                                  Also for env-diff and validate. A redirect inside the same origin is always followed.
  --auth-env VAR                 send Authorization: Bearer $VAR
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
            case 'env-diff': return await envDiffCommand(io, args, secrets)
            case 'validate': return await validateCommand(io, args, secrets)
            case 'repro': return await reproCommand(io, args)
            case 'curl': return await curlCommand(io, args)
            case 'probe': return await probeCommand(io, args, secrets)
            case 'test': return await testCommand(io, args, secrets)
            case 'replay': return await replayCommand(io, args)
            case 'fixtures': return await fixturesCommand(io, args)
            default:
                io.err(`${sanitizeText(`Unknown command: ${command}`)}\nRun "sse-doctor --help" for usage.\n`)
                return EXIT.usage
        }
    } catch (error) {
        // a message may quote text that came from argv or from a file (a URL, an option, a path, a scenario field): it must not drive the terminal
        if (error instanceof CliError) { io.err(`${sanitizeText(error.message)}\n`); return error.exit }
        io.err(`sse-doctor could not finish: ${sanitizeText(error instanceof Error ? error.message : String(error))}\n`)
        return EXIT.couldNotRun
    } finally {
        io.flush() // what an output held back because it could have been the start of a secret
    }
}
