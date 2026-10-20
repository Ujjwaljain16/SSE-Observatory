/**
 * Lining up the events of two captures. The `dataHash` on an event record is salted per capture and is never equal
 * across captures, so it is not used here. Payload identity comes from hashing the decoded event text locally.
 */

import type { Capture } from '../format'
import { sha256Hex } from '../sha256'
import { framesOf } from '../streamText'
import { ofKind } from './records'

export interface EventView {
    /** Position among the capture's event records. */
    index: number
    seq: number
    t: number
    name: string
    id: string
    /** Hash of the payload text; undefined when the capture has no way to recover it. */
    hash: string | undefined
    /** `extracted.seq` (with the partition, if any) as a comparable key. */
    numKey: string | undefined
}

export interface EventViews {
    views: EventView[]
    /** True when payload text could be rebuilt for the events, so the payload hash is available. */
    hasText: boolean
}

export function eventViews(capture: Capture): EventViews {
    const records = ofKind(capture.records, 'event')
    const frames = framesOf(capture)
    // frames are paired with event records by position, which holds unless the capture was cut short
    const hasText = frames.length > 0 && frames.length === records.length
    const views = records.map((r, index): EventView => {
        const extractedSeq = r.extracted?.seq
        return {
            index, seq: r.seq, t: r.t, name: r.event, id: r.sseId,
            hash: hasText ? sha256Hex(frames[index]!.data) : undefined,
            numKey: extractedSeq === undefined ? undefined : `${r.extracted?.partition ?? ''}\u0000${String(extractedSeq)}`,
        }
    })
    return { views, hasText }
}

export type MatchMethod = 'id' | 'payload' | 'seq'

export interface Pair { a: EventView; b: EventView; by: MatchMethod }

export interface Alignment {
    /** In the order of A. */
    pairs: Pair[]
    onlyA: EventView[]
    onlyB: EventView[]
}

function takeFirst(map: Map<string, EventView[]>, key: string): EventView | undefined {
    const list = map.get(key)
    return list?.shift()
}

function bucket(views: readonly EventView[], keyOf: (v: EventView) => string | undefined): Map<string, EventView[]> {
    const map = new Map<string, EventView[]>()
    for (const v of views) {
        const key = keyOf(v)
        if (key === undefined) continue
        const list = map.get(key)
        if (list) list.push(v); else map.set(key, [v])
    }
    return map
}

/** Matches by non-empty id first, then by event name and payload hash, then by the extracted sequence number. */
export function alignEvents(a: readonly EventView[], b: readonly EventView[]): Alignment {
    const matchedA = new Map<number, Pair>()
    const usedB = new Set<number>()

    const pass = (by: MatchMethod, keyOf: (v: EventView) => string | undefined): void => {
        const pool = bucket(b.filter((v) => !usedB.has(v.index)), keyOf)
        for (const va of a) {
            if (matchedA.has(va.index)) continue
            const key = keyOf(va)
            if (key === undefined) continue
            const vb = takeFirst(pool, key)
            if (!vb) continue
            matchedA.set(va.index, { a: va, b: vb, by })
            usedB.add(vb.index)
        }
    }
    pass('id', (v) => (v.id === '' ? undefined : v.id))
    pass('payload', (v) => (v.hash === undefined ? undefined : `${v.name}\u0000${v.hash}`))
    pass('seq', (v) => v.numKey)

    return {
        pairs: a.filter((v) => matchedA.has(v.index)).map((v) => matchedA.get(v.index)!),
        onlyA: a.filter((v) => !matchedA.has(v.index)),
        onlyB: b.filter((v) => !usedB.has(v.index)),
    }
}

/** How many matched events are out of order: the pairs that are not on the longest run that keeps A's order in B. */
export function movedCount(pairs: readonly Pair[]): number {
    const tails: number[] = []
    for (const p of pairs) {
        let lo = 0
        let hi = tails.length
        while (lo < hi) {
            const mid = (lo + hi) >> 1
            if (tails[mid]! < p.b.index) lo = mid + 1; else hi = mid
        }
        tails[lo] = p.b.index
    }
    return pairs.length - tails.length
}
