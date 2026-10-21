/**
 * The raw order of a stream's numbers, for the Sequence view. This is the plain reading (what came after what), not the
 * rule: the rule gives a late event a reorder window before calling a gap, and treats a resume's replay as expected.
 * Both views are shown so that what the rule decided can be checked against what arrived.
 */

import type { Observation } from '../core/observe/observation'

export type CellState =
    /** The next number after the highest seen (or the first). */
    | 'ok'
    /** Numbers skipped before this one (policy `consecutive` only). */
    | 'gap'
    /** Seen before. */
    | 'duplicate'
    /** Lower than the highest seen and not seen before: late, or the stream went backwards. */
    | 'backward'

export interface SequenceCell {
    /** Record number of the event, to find it in the recording. */
    recordSeq: number
    t: number
    conn: number
    value: number
    state: CellState
    /** For a gap: the numbers that were skipped. */
    missing?: { from: number; to: number } | undefined
    partition?: string | undefined
}

export interface SequenceReading {
    cells: SequenceCell[]
    /** Events whose number could not be read (no extracted number): recorded before the sequence was declared, or the field is absent. */
    unreadable: number
}

type EventRecord = Extract<Observation, { kind: 'event' }>

/** Classifies each event's number against the ones before it, per partition. */
export function readSequence(records: readonly Observation[], policy: 'consecutive' | 'monotonic', limit = 400): SequenceReading {
    const state = new Map<string, { high: number | undefined; seen: Set<number> }>()
    const cells: SequenceCell[] = []
    let unreadable = 0
    for (const r of records) {
        if (r.kind !== 'event') continue
        const e = r as EventRecord
        const raw = e.extracted?.seq
        const value = typeof raw === 'number' ? raw : typeof raw === 'string' && /^-?\d+$/.test(raw) ? Number(raw) : undefined
        if (value === undefined || !Number.isFinite(value)) { unreadable++; continue }
        const partition = e.extracted?.partition
        const key = partition ?? ''
        let p = state.get(key)
        if (!p) { p = { high: undefined, seen: new Set() }; state.set(key, p) }
        let cell: SequenceCell
        if (p.high === undefined) cell = { recordSeq: e.seq, t: e.t, conn: e.conn, value, state: 'ok', partition }
        else if (p.seen.has(value)) cell = { recordSeq: e.seq, t: e.t, conn: e.conn, value, state: 'duplicate', partition }
        else if (value < p.high) cell = { recordSeq: e.seq, t: e.t, conn: e.conn, value, state: 'backward', partition }
        else if (policy === 'consecutive' && value > p.high + 1) cell = { recordSeq: e.seq, t: e.t, conn: e.conn, value, state: 'gap', missing: { from: p.high + 1, to: value - 1 }, partition }
        else cell = { recordSeq: e.seq, t: e.t, conn: e.conn, value, state: 'ok', partition }
        p.seen.add(value)
        if (p.seen.size > 5000) p.seen.delete(p.seen.values().next().value as number) // bounded, like the rule's window
        if (p.high === undefined || value > p.high) p.high = value
        cells.push(cell)
    }
    return { cells: cells.length > limit ? cells.slice(cells.length - limit) : cells, unreadable }
}

export type Trust = 'declared' | 'inferred' | 'none'

/**
 * How far the numbers can be trusted as a sequence. Only a declaration counts. Ids that merely look like a counter are
 * reported as a hint and never judged.
 */
export function trustOf(declared: boolean, sseIds: readonly string[]): Trust {
    if (declared) return 'declared'
    const numeric = sseIds.filter((id) => /^\d+$/.test(id)).map(Number)
    if (numeric.length < 5 || numeric.length < sseIds.length * 0.9) return 'none'
    for (let i = 1; i < numeric.length; i++) if (numeric[i]! !== numeric[i - 1]! + 1) return 'none'
    return 'inferred'
}
