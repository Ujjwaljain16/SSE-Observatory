import type { ObservationKind } from '../observe/observation'
import type { FindingDraft } from './finding'
import type { EngineInput, StreamModel } from './streamModel'
import type { StreamProfile, Thresholds } from './thresholds'

/**
 * What a rule needs the capture to contain. A capability is satisfied when the capture shows the recorder that
 * produced it was able to record it, which is not the same as the thing having happened: a healthy stream has no
 * violation records, but a capture with chunk records came from a recorder that would have emitted them.
 */
export type Capability = 'connect' | 'response' | 'chunks' | 'comments' | 'violations' | 'events' | 'phases' | 'reconnects' | 'raw' | 'payload' | 'consumer'

/** Record kinds whose presence is evidence that a capability exists. */
export const CAPABILITY_EVIDENCE: Record<Capability, ObservationKind[]> = {
    connect: ['connect'],
    response: ['response'],
    chunks: ['chunk'],
    comments: ['chunk', 'comment', 'heartbeatSeries'],
    violations: ['response', 'chunk', 'violation', 'comment'],
    events: ['chunk', 'event'],
    phases: ['phase'],
    reconnects: ['reconnect', 'phase'],
    raw: [],
    payload: ['event'],
    consumer: ['consumer'],
}

export interface RuleContext {
    thresholds: Thresholds
    profile: StreamProfile
}

export interface RuleCoverageNote {
    /** False when the rule cannot judge this capture even though its capabilities are present (for example, no response headers). */
    evaluated: boolean
    /** Why not, or what part of the rule is not evaluated. */
    notes: string[]
}

/**
 * A rule instance holds its own state. The contract that keeps live and batch analysis identical:
 *  - `onObservation` and `onEnd` may change that state and return findings to keep;
 *  - `onTick` must NOT change state. It returns provisional findings for whatever is still going on at `nowT`,
 *    which are shown until the next observation replaces them.
 */
export interface RuleInstance {
    onObservation(o: EngineInput, model: StreamModel): FindingDraft[] | void
    onTick?(nowT: number, model: StreamModel): FindingDraft[] | void
    onEnd?(endT: number, model: StreamModel): FindingDraft[] | void
    /** Extra coverage detail for this capture. */
    coverage?(model: StreamModel): RuleCoverageNote
}

export interface Rule {
    id: string
    version: number
    title: string
    requires: Capability[]
    create(ctx: RuleContext): RuleInstance
}
