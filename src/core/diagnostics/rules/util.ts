import type { Evidence } from '../finding'

/** "850 ms", "4.2 s", "30 s". */
export function fmtMs(ms: number): string {
    if (ms < 1000) return `${Math.round(ms)} ms`
    const s = ms / 1000
    return `${Number.isInteger(s) ? s : s.toFixed(1)} s`
}

export const ev = (seq: number, t: number, note?: string): Evidence => (note === undefined ? { seq, t } : { seq, t, note })

export const plural = (n: number, one: string, many = `${one}s`): string => `${n} ${n === 1 ? one : many}`
