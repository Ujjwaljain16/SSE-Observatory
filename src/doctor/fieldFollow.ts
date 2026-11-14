import { getJsonPath } from '../core/observe/jsonPath'
import type { EventMessage } from '../types'
import { getParsedData } from '../utils/eventUtils'

/** What one field did across the events looked at. */
export interface FollowSummary {
    path: string
    /** Events looked at. */
    total: number
    /** Events that have the field with a value. */
    present: number
    kind: 'none' | 'number' | 'text' | 'boolean' | 'mixed'
    /** The newest value, as written. */
    latest?: string | undefined
    /** How many different values (counted up to a limit). */
    distinct: number
    /** True when more different values appeared than are counted. */
    distinctCapped: boolean
    /** For a number field. */
    numeric?: {
        min: number
        max: number
        mean: number
        first: number
        last: number
        /** Oldest to newest, at most `POINTS` values, each the mean of a stretch of the events. */
        points: number[]
        direction: 'rising' | 'falling' | 'flat' | 'mixed'
        ups: number
        downs: number
        /** Every step was exactly +1: a counter. */
        counter: boolean
    } | undefined
    /** For a text or boolean field: the most common values. */
    top?: Array<{ value: string; count: number }> | undefined
}

export const POINTS = 120
export const MAX_EVENTS_LOOKED_AT = 20_000
const MAX_DISTINCT = 5000
const TOP = 8

/** At most `n` values: each the mean of an equal stretch, so a long series keeps its shape. Fewer than `n` come back as they are. */
export function downsample(values: readonly number[], n = POINTS): number[] {
    if (values.length <= n) return [...values]
    const out: number[] = []
    for (let i = 0; i < n; i++) {
        const from = Math.floor((i * values.length) / n)
        const to = Math.max(from + 1, Math.floor(((i + 1) * values.length) / n))
        let sum = 0
        for (let j = from; j < to; j++) sum += values[j]!
        out.push(sum / (to - from))
    }
    return out
}

/**
 * Follows one field over the events: the newest first, as the app keeps them. The path is read with the same reader the profile uses,
 * so `$.seq`, `data.id` and `items[0].price` all work. Looks at the newest `limit` events and says how many that was.
 */
export function followField(eventsNewestFirst: readonly EventMessage[], path: string, limit = MAX_EVENTS_LOOKED_AT): FollowSummary {
    const events = eventsNewestFirst.length > limit ? eventsNewestFirst.slice(0, limit) : eventsNewestFirst
    const numbers: number[] = []
    const kinds = new Set<'number' | 'text' | 'boolean'>()
    const counts = new Map<string, number>()
    let distinctCapped = false
    let present = 0
    let latest: string | undefined

    // oldest first, so the series reads in the order things happened
    for (let i = events.length - 1; i >= 0; i--) {
        const payload = getParsedData(events[i]!)
        if (payload === undefined) continue
        const value = getJsonPath(payload, path)
        if (value === undefined || value === null) continue
        let text: string
        if (typeof value === 'number' && Number.isFinite(value)) { kinds.add('number'); numbers.push(value); text = String(value) }
        else if (typeof value === 'boolean') { kinds.add('boolean'); text = String(value) }
        else if (typeof value === 'string') { kinds.add('text'); text = value }
        else { kinds.add('text'); try { text = JSON.stringify(value) } catch { continue } }
        present++
        latest = text
        if (counts.has(text)) counts.set(text, counts.get(text)! + 1)
        else if (counts.size < MAX_DISTINCT) counts.set(text, 1)
        else distinctCapped = true
    }

    const kind: FollowSummary['kind'] = kinds.size === 0 ? 'none' : kinds.size > 1 ? 'mixed' : [...kinds][0]!
    const summary: FollowSummary = { path, total: events.length, present, kind, latest, distinct: counts.size, distinctCapped }

    if (kind === 'number') {
        let min = Infinity, max = -Infinity, sum = 0, ups = 0, downs = 0, counter = numbers.length >= 3
        numbers.forEach((n, i) => {
            if (n < min) min = n
            if (n > max) max = n
            sum += n
            if (i > 0) {
                const step = n - numbers[i - 1]!
                if (step > 0) ups++
                else if (step < 0) downs++
                if (step !== 1) counter = false
            }
        })
        summary.numeric = {
            min, max, mean: sum / numbers.length, first: numbers[0]!, last: numbers[numbers.length - 1]!, points: downsample(numbers),
            direction: ups === 0 && downs === 0 ? 'flat' : downs === 0 ? 'rising' : ups === 0 ? 'falling' : 'mixed',
            ups, downs, counter,
        }
    } else if (kind === 'text' || kind === 'boolean') {
        summary.top = [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, TOP).map(([value, count]) => ({ value, count }))
    }
    return summary
}
