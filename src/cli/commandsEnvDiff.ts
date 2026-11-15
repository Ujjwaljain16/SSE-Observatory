/**
 * `sse-doctor env-diff <urlA> <urlB>`: read the same stream through two paths at the same time (the origin and the CDN, staging and
 * production, a stream before and after a proxy change) and say where its behaviour differs.
 *
 * Both are read at once, so they see the same moment of the stream, not two moments apart. Every setting (duration, limits, profile, the
 * credentials flags) applies to both; `--auth-env-a` / `--auth-env-b` (and the cookie, header and query ones) give one side its own, because
 * two environments rarely share a token. The result is the comparison the app and `sse-doctor compare` give for two saved captures, so it
 * measures the difference and never names a layer: two paths cannot say which hop caused it.
 */

import { redactUrl } from '../core/observe/redactUrl'
import { compareCaptures } from '../core/capture/derived/compare'
import { SEVERITY_RANK, type Finding } from '../core/diagnostics/finding'
import { stringFlag, type ParsedArgs } from './args'
import { analysisOf, observe, refuseNoRedactWithSecrets, saveObserved, secretOptionsIn, show, type Observed } from './commands'
import { CliError, EXIT, type CliIo } from './io'
import type { SecretRegistry } from './secretRegistry'

type Side = 'a' | 'b'

/** The arguments as one side sees them: the shared credential flags, replaced by that side's own where it gave some. */
export function sideArgs(args: ParsedArgs, side: Side): ParsedArgs {
    const flags = { ...args.flags }
    const multi = { ...args.multi }
    for (const name of ['auth-env', 'cookie-env']) {
        const own = args.flags[`${name}-${side}`]
        if (typeof own === 'string') flags[name] = own
    }
    for (const name of ['header-env', 'query-env']) {
        const own = args.multi[`${name}-${side}`]
        if (own && own.length > 0) multi[name] = own
    }
    flags['side'] = side // not an option anyone can pass: it lets a message name the side's own option (--auth-env-a)
    return { positionals: args.positionals, flags, multi }
}

const describeFindings = (findings: Finding[]): string => {
    const open = findings.filter((f) => f.status === 'open')
    if (open.length === 0) return 'no findings'
    return [...open].sort((x, y) => SEVERITY_RANK[y.severity] - SEVERITY_RANK[x.severity]).map((f) => `${f.key} (${f.severity})`).join(', ')
}

function sentence(label: string, o: Observed, findings: Finding[]): string {
    const seen = o.answered
        ? `${o.events} event${o.events === 1 ? '' : 's'} in ${(o.endT / 1000).toFixed(1)} s (stopped: ${o.reason})`
        : 'the server never answered'
    return `${label} ${redactUrl(o.target)}: ${seen}; on its own: ${describeFindings(findings)}.`
}

export async function envDiffCommand(io: CliIo, args: ParsedArgs, secrets: SecretRegistry): Promise<number> {
    const [, urlA, urlB] = args.positionals
    const ok = (u: string | undefined): u is string => u !== undefined && /^https?:\/\//i.test(u)
    if (!ok(urlA) || !ok(urlB)) {
        throw new CliError('Usage: sse-doctor env-diff <http(s) url A> <http(s) url B> [--label-a name] [--label-b name] [--duration s] [--out-a file] [--out-b file]\n  Credentials: --auth-env / --header-env / --query-env / --cookie-env apply to both; add -a or -b to the name (--auth-env-b TOKEN_B) to give one side its own.', EXIT.usage)
    }
    const labelA = stringFlag(args, 'label-a') ?? 'A'
    const labelB = stringFlag(args, 'label-b') ?? 'B'
    const outA = stringFlag(args, 'out-a')
    const outB = stringFlag(args, 'out-b')
    refuseNoRedactWithSecrets(args, [...new Set([...secretOptionsIn(sideArgs(args, 'a'), urlA), ...secretOptionsIn(sideArgs(args, 'b'), urlB)])])
    if ((outA || outB) && args.flags['no-redact'] === true) io.err('warning: --no-redact writes captures that may contain secrets. Do not share them.\n')

    // One side failing to start (a variable that is not set, a bad flag) stops the other at once instead of leaving it to run out its time.
    const stop = new AbortController()
    const onOuterAbort = () => stop.abort()
    io.signal?.addEventListener('abort', onOuterAbort)
    const sideIo: CliIo = { ...io, signal: stop.signal }
    const run = (side: Side, url: string) => observe(sideIo, sideArgs(args, side), url, secrets).catch((error: unknown) => { stop.abort(); throw error })
    const [first, second] = await Promise.allSettled([run('a', urlA), run('b', urlB)])
    io.signal?.removeEventListener('abort', onOuterAbort)
    for (const settled of [first, second]) if (settled.status === 'rejected') throw settled.reason
    if (first.status !== 'fulfilled' || second.status !== 'fulfilled') throw new CliError('Both probes failed to start.', EXIT.couldNotRun)
    const a = first.value
    const b = second.value

    if (outA) await saveObserved(io, args, a.capture, outA)
    if (outB) await saveObserved(io, args, b.capture, outB)

    const analysisA = analysisOf(a.capture, a.profile)
    const analysisB = analysisOf(b.capture, b.profile)
    const differences = compareCaptures(a.capture, b.capture)
    const notes = [
        sentence(labelA, a, analysisA.findings),
        sentence(labelB, b, analysisB.findings),
        ...(outA ? [`${labelA} capture written to ${outA}${args.flags['no-redact'] === true ? ' (NOT redacted)' : ' (redacted)'}.`] : []),
        ...(outB ? [`${labelB} capture written to ${outB}${args.flags['no-redact'] === true ? ' (NOT redacted)' : ' (redacted)'}.`] : []),
        'Both were read at the same time with the same settings. A difference is a measurement; which hop caused it cannot be told from two readings.',
    ]
    const coverage = [{ ruleId: 'compare', ruleVersion: 1, title: 'Capture comparison', status: 'evaluated' as const, missingCapabilities: [], missingKinds: [], notes: [] }]
    const code = show(io, { command: 'env-diff', subject: `${labelA} vs ${labelB}`, findings: differences, coverage, notes }, args)
    if (a.reason === 'interrupted' || b.reason === 'interrupted') return EXIT.interrupted
    // A side that never answered cannot be compared: the run could not do what was asked, whatever the gate says.
    if (!a.answered || !b.answered) return EXIT.couldNotRun
    return code
}
