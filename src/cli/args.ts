import { CliError, EXIT } from './io'

type FlagKind = 'bool' | 'string' | 'multi'

/** Every flag the CLI knows. A flag meant for one command is accepted by all; a command ignores what it does not use. */
const FLAGS: Record<string, FlagKind> = {
    format: 'string', output: 'string', out: 'string', quiet: 'bool', verbose: 'bool', 'no-color': 'bool',
    profile: 'string', 'fail-on': 'string', redact: 'bool', 'no-redact': 'bool', timeout: 'string',
    duration: 'string', 'max-events': 'string', 'idle-timeout': 'string',
    'auth-env': 'string', 'cookie-env': 'string', 'header-env': 'multi', 'query-env': 'multi', header: 'multi',
    fixtures: 'bool', port: 'string', speed: 'string', 'honor-last-event-id': 'bool', 'drop-after': 'string', 'skip-ids': 'string',
    'allow-inconclusive': 'bool', end: 'string', shell: 'string', finding: 'string', scenario: 'string', test: 'string',
}

export interface ParsedArgs {
    positionals: string[]
    flags: Record<string, string | boolean>
    multi: Record<string, string[]>
}

export function parseArgs(argv: string[]): ParsedArgs {
    const positionals: string[] = []
    const flags: Record<string, string | boolean> = {}
    const multi: Record<string, string[]> = {}
    for (let i = 0; i < argv.length; i++) {
        const arg = argv[i]!
        if (!arg.startsWith('--')) { positionals.push(arg); continue }
        const eq = arg.indexOf('=')
        const name = eq < 0 ? arg.slice(2) : arg.slice(2, eq)
        const kind = FLAGS[name]
        if (kind === undefined) throw new CliError(`Unknown option --${name}. Run "sse-doctor --help".`, EXIT.usage)
        if (kind === 'bool') { flags[name] = true; continue }
        const value = eq >= 0 ? arg.slice(eq + 1) : argv[++i]
        if (value === undefined) throw new CliError(`Option --${name} needs a value.`, EXIT.usage)
        if (kind === 'multi') (multi[name] ??= []).push(value)
        else flags[name] = value
    }
    return { positionals, flags, multi }
}

export function numberFlag(args: ParsedArgs, name: string, fallback: number): number {
    const raw = args.flags[name]
    if (raw === undefined || raw === true) return fallback
    const n = Number(raw)
    if (!Number.isFinite(n) || n < 0) throw new CliError(`Option --${name} must be a non-negative number, got "${String(raw)}".`, EXIT.usage)
    return n
}

export function stringFlag(args: ParsedArgs, name: string): string | undefined {
    const raw = args.flags[name]
    return typeof raw === 'string' ? raw : undefined
}
