/**
 * Looks at recent event payloads and lists the fields that could be a sequence number or a producer timestamp, so a person
 * can declare one with a click instead of typing a path. The result is a suggestion; nothing is declared until it is saved.
 */

export interface FieldSuggestion {
    path: string
    /** A recent value, shortened. */
    sample: string
    kind: 'counter' | 'timestamp' | 'number' | 'other'
    /** Whole numbers that went up by exactly one each time over the samples. */
    counter: boolean
}

const MAX_DEPTH = 4
const MAX_FIELDS = 60

function leaves(value: unknown, path: string, depth: number, out: Map<string, unknown>): void {
    if (out.size >= MAX_FIELDS) return
    if (value === null || value === undefined) return
    if (typeof value === 'object') {
        if (depth >= MAX_DEPTH) return
        if (Array.isArray(value)) { value.slice(0, 3).forEach((v, i) => leaves(v, `${path}[${i}]`, depth + 1, out)); return }
        for (const [k, v] of Object.entries(value as Record<string, unknown>)) if (/^[A-Za-z0-9_-]+$/.test(k)) leaves(v, `${path}.${k}`, depth + 1, out)
        return
    }
    out.set(path, value)
}

const isEpochMs = (n: number): boolean => n > 9e11 && n < 4.2e12
const isIsoDate = (s: string): boolean => /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(s) && !Number.isNaN(Date.parse(s))

/** `payloads` are parsed event data, oldest first. */
export function suggestFields(payloads: readonly unknown[]): FieldSuggestion[] {
    const perPath = new Map<string, unknown[]>()
    for (const payload of payloads.slice(-30)) {
        const found = new Map<string, unknown>()
        leaves(payload, '$', 0, found)
        for (const [path, value] of found) {
            const list = perPath.get(path) ?? []
            list.push(value)
            perPath.set(path, list)
        }
    }
    const out: FieldSuggestion[] = []
    for (const [path, values] of perPath) {
        if (path === '$') continue
        const last = values[values.length - 1]
        const numbers = values.filter((v): v is number => typeof v === 'number')
        const wholeNumbers = numbers.length === values.length && numbers.every(Number.isInteger)
        const counter = wholeNumbers && numbers.length >= 3 && numbers.every((n, i) => i === 0 || n === numbers[i - 1]! + 1)
        let kind: FieldSuggestion['kind'] = 'other'
        if (counter) kind = 'counter'
        else if ((typeof last === 'number' && isEpochMs(last)) || (typeof last === 'string' && isIsoDate(last))) kind = 'timestamp'
        else if (typeof last === 'number') kind = 'number'
        if (kind === 'other') continue
        out.push({ path, sample: String(last).slice(0, 40), kind, counter })
    }
    const rank = { counter: 0, timestamp: 1, number: 2, other: 3 } as const
    return out.sort((a, b) => rank[a.kind] - rank[b.kind] || a.path.localeCompare(b.path))
}
