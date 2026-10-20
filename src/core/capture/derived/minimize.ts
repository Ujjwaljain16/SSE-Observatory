/**
 * Shrinks a capture to the smallest set of records that still shows one finding (delta debugging, "ddmin"): drop pieces,
 * keep the drop if the finding is still reported, try finer pieces when nothing more can be dropped. The result is a
 * small, readable reproduction of a problem, which is what a bug report and a regression test need.
 *
 * The analysis is deterministic, so "still shows the finding" has one answer for a given set of records. The end time of
 * the original capture is kept, so a finding about silence at the end (a stall) still has its silence to measure.
 */

import { analyze } from '../../diagnostics/engine'
import type { StreamProfile } from '../../diagnostics/thresholds'
import type { EngineInput } from '../../diagnostics/streamModel'
import type { Capture, CaptureRecord } from '../format'

export interface MinimizeOptions {
    /** Stop after this many analyses (default 3000). The best result so far is returned, with `complete: false`. */
    maxRuns?: number | undefined
    profile?: StreamProfile | undefined
}

export interface MinimizeResult {
    /** The reduced capture; the original when the finding is not reported by it at all. */
    capture: Capture
    reproduced: boolean
    /** False when the run limit was reached before no further record could be dropped. */
    complete: boolean
    runs: number
    originalRecords: number
    minimalRecords: number
}

const matches = (key: string, found: string): boolean => found === key || found.startsWith(`${key}:`) || key.startsWith(`${found}:`)

export function minimizeCapture(capture: Capture, findingKey: string, options: MinimizeOptions = {}): MinimizeResult {
    const maxRuns = options.maxRuns ?? 3000
    const profile = options.profile ?? capture.header.profile
    const all = capture.records
    const endT = all.reduce((t, r) => Math.max(t, r.t), 0)
    let runs = 0

    const reports = (indices: number[]): boolean => {
        runs++
        const records = indices.map((i) => all[i]!) as unknown as EngineInput[]
        return analyze(records, { ...(profile ? { profile } : {}), endT }).findings.some((f) => f.status === 'open' && matches(findingKey, f.key))
    }

    const everything = all.map((_, i) => i)
    if (!reports(everything)) return { capture, reproduced: false, complete: true, runs, originalRecords: all.length, minimalRecords: all.length }

    let current = everything
    let n = 2
    let complete = true
    while (current.length >= 2) {
        if (runs >= maxRuns) { complete = false; break }
        const size = Math.ceil(current.length / n)
        const chunks: number[][] = []
        for (let i = 0; i < current.length; i += size) chunks.push(current.slice(i, i + size))

        let reduced = false
        // Drop one piece at a time: the rest is smaller and still shows the finding.
        for (const chunk of chunks) {
            if (runs >= maxRuns) break
            const drop = new Set(chunk)
            const rest = current.filter((i) => !drop.has(i))
            if (rest.length > 0 && reports(rest)) { current = rest; n = Math.max(n - 1, 2); reduced = true; break }
        }
        if (!reduced) {
            // Or one piece alone is enough.
            for (const chunk of chunks) {
                if (runs >= maxRuns) break
                if (chunk.length < current.length && reports(chunk)) { current = chunk; n = 2; reduced = true; break }
            }
        }
        if (!reduced) {
            if (n >= current.length) break // pieces of one record each, and none can go
            n = Math.min(current.length, n * 2)
        }
    }

    const records: CaptureRecord[] = current.map((i) => all[i]!)
    return {
        capture: { ...capture, records, footer: undefined },
        reproduced: true,
        complete: complete && runs < maxRuns,
        runs,
        originalRecords: all.length,
        minimalRecords: records.length,
    }
}
