/**
 * `sse-doctor validate <capture> <url>`: did the fix work? Take a capture that showed a bug, read the stream the fix is deployed on the way
 * the capture was read, and say whether the same finding is still there.
 *
 *   exit 0  fixed: the finding is gone, and the check that raised it could run on this reading
 *   exit 1  not fixed: the same finding is reported again
 *   exit 4  inconclusive: the finding is gone, but the check could not run on this reading (a stall needs time, a gap needs a declared
 *           sequence), so "gone" is not evidence of "fixed"
 *   exit 3  the stream never answered
 *   exit 2  the capture does not show the finding it was asked about, so there is nothing to validate against
 *
 * It does not say a stream is healthy: only that this finding, from this capture, did not come back in this reading. Other findings the
 * reading raised are listed, not judged.
 */

import { SEVERITY_RANK, type Finding } from '../core/diagnostics/finding'
import { describeProfile } from '../core/diagnostics/profile'
import type { StreamProfile } from '../core/diagnostics/thresholds'
import { captureEndT } from '../core/capture/format'
import { redactUrl } from '../core/observe/redactUrl'
import { stringFlag, type ParsedArgs } from './args'
import { analysisOf, loadCapture, observe, show } from './commands'
import { CliError, EXIT, type CliIo } from './io'
import type { SecretRegistry } from './secretRegistry'

const keyList = (findings: Finding[]): string => findings.map((f) => f.key).join(', ') || 'none'

/**
 * What a profile changes about what the checks can judge: the declared sequence, the delivery promise, the producer timestamp and the
 * expected timings. How events are shown, and whether payload shapes are kept, change nothing about that.
 */
const judging = (p: StreamProfile | undefined): string => JSON.stringify({ s: p?.sequence ?? null, d: p?.delivery ?? null, t: p?.timestampField ?? null, e: p?.expected ?? null })

export async function validateCommand(io: CliIo, args: ParsedArgs, secrets: SecretRegistry): Promise<number> {
    const [, path, url] = args.positionals
    if (!path || !url || !/^https?:\/\//i.test(url)) {
        throw new CliError('Usage: sse-doctor validate <capture> <http(s) url of the fixed stream> [--finding key] [--duration s] [--max-events n]\n  The stream is read with the capture\'s own profile unless --profile is given; credentials are given as for probe (--auth-env, --header-env, ...).', EXIT.usage)
    }
    const { capture } = await loadCapture(io, path)
    const before = analysisOf(capture, capture.header.profile)
    const open = before.findings.filter((f) => f.status === 'open')
    const wanted = stringFlag(args, 'finding')
    const target = wanted
        ? open.find((f) => f.key === wanted)
        : [...open].sort((a, b) => SEVERITY_RANK[b.severity] - SEVERITY_RANK[a.severity])[0]
    if (!target) {
        throw new CliError(wanted
            ? `The capture does not report "${wanted}", so there is nothing to validate a fix against. Findings it does report: ${keyList(open)}.`
            : `The capture reports no finding, so there is nothing to validate a fix against.`, EXIT.usage)
    }

    // A stall or a late first event needs the reading to last as long as the problem took to show: at least as long as the capture, and 30 s.
    const sinceStart = Math.ceil(captureEndT(capture) / 1000 * 1.2)
    const chosenDuration = args.flags['duration'] === undefined
    const withDuration: ParsedArgs = chosenDuration ? { ...args, flags: { ...args.flags, duration: String(Math.min(300, Math.max(30, sinceStart))) } } : args

    const o = await observe(io, withDuration, url, secrets, capture.header.profile)
    const after = analysisOf(o.capture, o.profile)
    const openAfter = after.findings.filter((f) => f.status === 'open')
    const same = openAfter.find((f) => f.key === target.key)
    const rule = after.coverage.find((c) => c.ruleId === target.ruleId)
    const sameRule = openAfter.filter((f) => f.ruleId === target.ruleId && f.key !== target.key)
    const others = openAfter.filter((f) => f.ruleId !== target.ruleId)

    let verdict: string
    let code: number
    if (!o.answered) { verdict = 'Could not tell: the stream never answered, so nothing was read.'; code = EXIT.couldNotRun }
    else if (same) { verdict = `Not fixed: "${target.key}" is reported again (${same.occurrences} time${same.occurrences === 1 ? '' : 's'}).`; code = EXIT.gateFailed }
    else if (judging(capture.header.profile) !== judging(o.profile)) {
        // A check that needs a declared sequence says "evaluated" for the rule as a whole while its sequence part cannot run, so the coverage list alone cannot be trusted here.
        verdict = `Inconclusive: "${target.key}" is not reported, but this reading was judged under a different profile than the capture (the capture: ${describeProfile(capture.header.profile)}; this reading: ${describeProfile(o.profile)}) and the finding may depend on it, so its absence does not show the fix worked.`
        code = EXIT.inconclusive
    } else if (rule && rule.status !== 'evaluated') {
        verdict = `Inconclusive: "${target.key}" is not reported, but the check that raises it could not run on this reading (${rule.notes.join(' ') || 'it needs something this reading did not have'}), so its absence does not show the fix worked.`
        code = EXIT.inconclusive
    } else { verdict = `Fixed, as far as this reading shows: "${target.key}" is not reported, and the check that raises it ran.`; code = EXIT.ok }

    const notes = [
        `Verdict: ${verdict}`,
        `The capture reported "${target.key}" (${target.severity}): ${target.title}.`,
        `Read ${redactUrl(url)} for ${(o.endT / 1000).toFixed(1)} s${chosenDuration ? ' (as long as the capture, and at least 30 s; --duration changes it)' : ''}: ${o.events} event${o.events === 1 ? '' : 's'} (stopped: ${o.reason}).`,
        ...(sameRule.length > 0 ? [`The same check reports something else now: ${keyList(sameRule)}.`] : []),
        ...(others.length > 0 ? [`This reading also reports, about other checks: ${keyList(others)}. They are not judged here.`] : []),
        ...(code === EXIT.ok ? ['To keep this as a test that fails if the problem comes back: sse-doctor repro <capture> --scenario <file>, then sse-doctor test <file>.'] : []),
        'One reading is not proof: a fault that comes and goes can be missing from it.',
    ]
    show(io, { command: 'validate', subject: `${path} against ${redactUrl(url)}`, findings: openAfter, coverage: after.coverage, notes }, args)
    return o.reason === 'interrupted' ? EXIT.interrupted : code
}
