import type { Severity } from '../../core/diagnostics'

/** "850 ms", "4.2 s", "3 min 05 s". */
export function fmtDuration(ms: number | null | undefined): string {
    if (ms === null || ms === undefined || !Number.isFinite(ms)) return '–'
    if (ms < 1000) return `${Math.round(ms)} ms`
    if (ms < 60_000) return `${(ms / 1000).toFixed(ms < 10_000 ? 1 : 0)} s`
    const min = Math.floor(ms / 60_000)
    const sec = Math.floor((ms % 60_000) / 1000)
    return `${min} min ${String(sec).padStart(2, '0')} s`
}

export const fmtAge = (ms: number | null | undefined): string => (ms === null || ms === undefined ? '–' : `${fmtDuration(ms)} ago`)

export function fmtBytes(n: number): string {
    if (n < 1024) return `${n} B`
    if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`
    return `${(n / (1024 * 1024)).toFixed(1)} MB`
}

/** Severity is shown by words and icon as well as colour. */
export const SEVERITY_LABEL: Record<Severity, string> = { info: 'Info', warning: 'Warning', error: 'Error', critical: 'Critical' }

export const SEVERITY_TEXT: Record<Severity, { dark: string; light: string }> = {
    info: { dark: 'text-sky-300', light: 'text-sky-800' },
    warning: { dark: 'text-amber-300', light: 'text-amber-800' },
    error: { dark: 'text-red-300', light: 'text-red-800' },
    critical: { dark: 'text-red-300', light: 'text-red-800' },
}

export const SEVERITY_BORDER: Record<Severity, string> = {
    info: 'border-l-sky-500',
    warning: 'border-l-amber-500',
    error: 'border-l-red-500',
    critical: 'border-l-red-600',
}
