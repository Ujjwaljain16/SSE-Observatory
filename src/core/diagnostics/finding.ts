/**
 * What the engine reports. A finding keeps three things apart so that a reader can never mistake a guess for a
 * measurement:
 *  - `facts`       what was observed. Measured, certain, each with the records that show it.
 *  - `deductions`  what is inferred from the facts. Always worded "Likely: ...", with a confidence and alternatives.
 *  - `limits`      what this check cannot know.
 */

export type Severity = 'info' | 'warning' | 'error' | 'critical'
export type Confidence = 'low' | 'medium' | 'high'

export const SEVERITY_RANK: Record<Severity, number> = { info: 0, warning: 1, error: 2, critical: 3 }

export const maxSeverity = (a: Severity, b: Severity): Severity => (SEVERITY_RANK[a] >= SEVERITY_RANK[b] ? a : b)

/** A pointer to the record that shows a fact: `seq` is the record's sequence number, `t` its time. */
export interface Evidence {
    seq: number
    t: number
    note?: string | undefined
}

export interface Fact {
    text: string
    evidence: Evidence[]
}

export interface Deduction {
    /** Starts with "Likely:" until a discriminating observation exists. */
    statement: string
    confidence: Confidence
    /** Sequence numbers of the records the deduction rests on. */
    basis: number[]
    /** Other explanations that fit the same facts. */
    alternatives: string[]
}

export interface NextCheck {
    description: string
    command?: string | undefined
}

export interface Finding {
    /** Stable identity within a capture, e.g. `stall.silent:bytes`. One finding per key. */
    key: string
    ruleId: string
    ruleVersion: number
    severity: Severity
    title: string
    summary: string
    facts: Fact[]
    deductions: Deduction[]
    nextCheck?: NextCheck | undefined
    limits: string[]
    /** `resolved` once the stream recovered (or the measured event is over); `open` while it may still be true. */
    status: 'open' | 'resolved'
    firstSeenT: number
    lastSeenT: number
    occurrences: number
    /** Machine-readable detail for consumers that act on a finding (for example the missing number ranges a scenario may allow). */
    data?: Record<string, unknown> | undefined
}

/** What a rule returns: a finding without the fields the engine fills in. Each draft replaces the finding with the same key. */
export type FindingDraft = Omit<Finding, 'ruleId' | 'ruleVersion' | 'status'> & { status?: Finding['status'] | undefined }
