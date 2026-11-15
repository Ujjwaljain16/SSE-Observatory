import type { CaptureRecord } from '../format'
import type { Observation, ObservationKind } from '../../observe/observation'

export type Of<K extends ObservationKind> = Extract<Observation, { kind: K }>

/** The records of one kind, typed. Unknown record kinds never match because known kinds are a closed list. */
export function ofKind<K extends ObservationKind>(records: readonly CaptureRecord[], kind: K): Of<K>[] {
    return records.filter((r) => r.kind === kind) as unknown as Of<K>[]
}

export function median(values: readonly number[]): number | undefined {
    if (values.length === 0) return undefined
    const sorted = [...values].sort((a, b) => a - b)
    const mid = sorted.length >> 1
    return sorted.length % 2 === 1 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2
}

/** The last timestamp in the capture: how long it ran, in milliseconds on its own clock. */
export function durationOf(records: readonly CaptureRecord[]): number {
    let last = 0
    for (const r of records) if (r.t > last) last = r.t
    return last
}
