/** Small number helpers shared by the Phase 7 rules. */

export function median(values: readonly number[]): number | undefined {
    if (values.length === 0) return undefined
    const s = [...values].sort((a, b) => a - b)
    const mid = s.length >> 1
    return s.length % 2 === 1 ? s[mid] : ((s[mid - 1] ?? 0) + (s[mid] ?? 0)) / 2
}

export function mean(values: readonly number[]): number | undefined {
    if (values.length === 0) return undefined
    let sum = 0
    for (const v of values) sum += v
    return sum / values.length
}

/** Coefficient of variation (population standard deviation over the mean); undefined when it is not meaningful. */
export function cv(values: readonly number[]): number | undefined {
    const m = mean(values)
    if (m === undefined || m <= 0) return undefined
    let sq = 0
    for (const v of values) sq += (v - m) ** 2
    return Math.sqrt(sq / values.length) / m
}

export const pct = (ratio: number): string => `${Math.round(ratio * 100)}%`
