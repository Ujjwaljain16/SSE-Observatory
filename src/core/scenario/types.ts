import type { Severity } from '../diagnostics/finding'

export type SequencePolicy = 'consecutive' | 'monotonic'
export type Delivery = 'at_least_once' | 'exactly_once' | 'at_most_once'

export type ScenarioSequence =
    | { field: string; use_sse_id?: undefined; policy: SequencePolicy }
    | { use_sse_id: true; field?: undefined; policy: SequencePolicy }

export interface ScenarioReplay {
    capture: string
    honor_last_event_id?: boolean | undefined
    test_aids?: { drop_after?: number | undefined; skip_ids?: string[] | undefined } | undefined
}

export interface ScenarioTarget {
    url?: string | undefined
    replay?: ScenarioReplay | undefined
    headers?: Record<string, string> | undefined
    sequence?: ScenarioSequence | undefined
    delivery?: Delivery | undefined
}

export interface ScenarioExpect {
    status?: number | undefined
    content_type?: string | undefined
    first_event_within_ms?: number | undefined
}

export type ScenarioStep =
    | { collect_events: number; timeout_ms?: number | undefined }
    | { disconnect: { mode: 'client' | 'server' } }
    | { reconnect: { after_ms?: number | undefined; resume_from_last_event_id?: boolean | undefined } }
    | { wait: { ms: number } }

export type VerifyCheck =
    | 'no_unexplained_sequence_gaps'
    | 'no_unexpected_duplicates'
    | 'preserve_event_order'
    | { no_findings_at_or_above: Severity }

export interface Scenario {
    $schema?: string | undefined
    version: 1
    name: string
    target: ScenarioTarget
    expect?: ScenarioExpect | undefined
    steps: ScenarioStep[]
    verify?: VerifyCheck[] | undefined
    fail_on_severity?: Severity | undefined
    allow_gaps?: { from: number; to: number }[] | undefined
    meta?: { notes?: string[] | undefined; origin?: string | undefined; [extra: string]: unknown } | undefined
}
