import { useEffect, useMemo, useState, useSyncExternalStore } from 'react'
import { Plus, X } from 'lucide-react'
import type { EventMessage, Theme } from '../types'
import { isJsonPath } from '../core/diagnostics/profile'
import { MAX_EVENTS_LOOKED_AT, followField, type FollowSummary } from '../doctor/fieldFollow'
import { listFieldPaths } from '../doctor/fieldSuggestions'
import { MAX_PINS, getPins, setPins, subscribePins } from '../doctor/pins'
import { getParsedData } from '../utils/eventUtils'

interface Props {
    theme: Theme
    /** The events held, newest first. */
    events: readonly EventMessage[]
    /** Reads the saved history (newest first), when the browser keeps one. Absent: only the events held are followed. */
    loadHistory?: (() => Promise<EventMessage[]>) | undefined
}

const W = 240
const H = 48

function Sparkline({ points, dark }: { points: number[]; dark: boolean }) {
    const min = Math.min(...points)
    const max = Math.max(...points)
    const span = max - min
    const x = (i: number) => (points.length === 1 ? W / 2 : (i / (points.length - 1)) * (W - 4) + 2)
    const y = (v: number) => (span === 0 ? H / 2 : H - 4 - ((v - min) / span) * (H - 8))
    return (
        <svg viewBox={`0 0 ${W} ${H}`} className="w-60 h-12 shrink-0" aria-hidden="true">
            <polyline fill="none" strokeWidth="1.5" className={dark ? 'stroke-sky-300' : 'stroke-sky-700'} points={points.map((v, i) => `${x(i).toFixed(1)},${y(v).toFixed(1)}`).join(' ')} />
        </svg>
    )
}

const fmt = (n: number) => (Number.isInteger(n) ? n.toLocaleString() : n.toLocaleString(undefined, { maximumFractionDigits: 3 }))

function describe(s: FollowSummary): string {
    if (s.kind === 'none') return `Not in any of the ${s.total.toLocaleString()} events looked at.`
    const parts = [`In ${s.present.toLocaleString()} of ${s.total.toLocaleString()} events`]
    if (s.latest !== undefined) parts.push(`newest value ${s.latest.length > 60 ? `${s.latest.slice(0, 60)}…` : s.latest}`)
    return `${parts.join('; ')}.`
}

function Card({ summary, dark, onRemove }: { summary: FollowSummary; dark: boolean; onRemove: () => void }) {
    const muted = dark ? 'text-slate-300' : 'text-slate-700'
    const strong = dark ? 'text-white' : 'text-slate-900'
    const n = summary.numeric
    const trend = n ? `${n.counter ? 'counts up by one' : n.direction}` : ''
    return (
        <li data-testid="followed-field" data-path={summary.path} className={`rounded-lg border p-3 space-y-2 ${dark ? 'border-slate-700' : 'border-slate-200'}`}>
            <div className="flex items-start justify-between gap-3">
                <div>
                    <code className={`text-sm font-semibold ${strong}`}>{summary.path}</code>
                    <p className={`text-xs ${muted}`} data-testid="followed-summary">{describe(summary)}</p>
                </div>
                <button type="button" onClick={onRemove} aria-label={`Stop following ${summary.path}`} className={`p-1 rounded ${dark ? 'hover:bg-slate-700 text-slate-200' : 'hover:bg-slate-100 text-slate-700'}`}>
                    <X className="w-4 h-4" aria-hidden="true" />
                </button>
            </div>

            {n && (
                <div className="flex flex-wrap items-center gap-4">
                    <div role="img" aria-label={`${summary.path} from ${fmt(n.first)} to ${fmt(n.last)}, lowest ${fmt(n.min)}, highest ${fmt(n.max)}, ${trend}`}>
                        <Sparkline points={n.points} dark={dark} />
                    </div>
                    <dl className={`grid grid-cols-2 gap-x-4 text-xs tabular-nums ${strong}`} data-testid="followed-numbers">
                        <dt className={muted}>First → newest</dt><dd>{fmt(n.first)} → {fmt(n.last)}</dd>
                        <dt className={muted}>Lowest / highest</dt><dd>{fmt(n.min)} / {fmt(n.max)}</dd>
                        <dt className={muted}>Mean</dt><dd>{fmt(n.mean)}</dd>
                        <dt className={muted}>Steps</dt><dd>{n.ups.toLocaleString()} up, {n.downs.toLocaleString()} down · {trend}</dd>
                    </dl>
                </div>
            )}

            {summary.top && (
                <ul className="space-y-1" aria-label={`Most common values of ${summary.path}`}>
                    {summary.top.map((t) => (
                        <li key={t.value} className="flex items-center gap-3 text-xs" data-testid="followed-value">
                            <span className={`w-40 shrink-0 truncate font-mono ${strong}`} title={t.value}>{t.value}</span>
                            <span aria-hidden="true" className={`flex-1 h-2.5 rounded ${dark ? 'bg-slate-700' : 'bg-slate-200'}`}>
                                <span className={`block h-2.5 rounded ${dark ? 'bg-sky-400' : 'bg-sky-700'}`} style={{ width: `${Math.max(2, Math.round((t.count / summary.present) * 100))}%` }} />
                            </span>
                            <span className={`w-24 shrink-0 text-right tabular-nums ${strong}`}>{t.count.toLocaleString()} ({Math.round((t.count / summary.present) * 100)}%)</span>
                        </li>
                    ))}
                    {summary.distinct > summary.top.length && <li className={`text-xs ${muted}`}>{(summary.distinctCapped ? `More than ${summary.distinct.toLocaleString()}` : (summary.distinct - summary.top.length).toLocaleString())} other value{summary.distinct - summary.top.length === 1 ? '' : 's'} not shown.</li>}
                </ul>
            )}
            {summary.kind === 'mixed' && <p className={`text-xs ${muted}`}>This field holds different kinds of value in different events, so only the newest is shown.</p>}
        </li>
    )
}

/** Follow fields of the payload across the events held (and, if asked, the saved history): the thing a pinned field is for. */
export function FollowedFields({ theme, events, loadHistory }: Props) {
    const dark = theme === 'dark'
    const muted = dark ? 'text-slate-300' : 'text-slate-700'
    const strong = dark ? 'text-white' : 'text-slate-900'
    const field = `rounded-lg border px-2 py-1 text-sm ${dark ? 'bg-slate-800 border-slate-600 text-white placeholder-slate-400' : 'bg-white border-slate-300 text-slate-900 placeholder-slate-500'}`
    const pins = useSyncExternalStore(subscribePins, getPins, () => [])
    const [draft, setDraft] = useState('')
    const [problem, setProblem] = useState('')
    const [useHistory, setUseHistory] = useState(false)
    const [history, setHistory] = useState<EventMessage[] | null>(null)
    const [loading, setLoading] = useState(false)

    useEffect(() => {
        if (!useHistory || !loadHistory) { setHistory(null); return }
        let cancelled = false
        setLoading(true)
        loadHistory().then((h) => { if (!cancelled) { setHistory(h); setLoading(false) } }, () => { if (!cancelled) { setHistory(null); setLoading(false) } })
        return () => { cancelled = true }
    }, [useHistory, loadHistory])

    const source = useHistory && history ? history : events
    const known = useMemo(() => {
        const payloads: unknown[] = []
        for (const e of events.slice(0, 30).reverse()) { const p = getParsedData(e); if (p !== undefined) payloads.push(p) }
        return listFieldPaths(payloads)
    }, [events])
    const summaries = useMemo(() => pins.map((path) => followField(source, path)), [pins, source])

    const add = () => {
        const path = draft.trim()
        if (path === '') return
        if (!isJsonPath(path)) { setProblem('That is not a JSON path. Use something like $.status or $.user.name or items[0].price.'); return }
        setProblem('')
        if (pins.includes(path)) { setProblem(`${path} is already followed.`); return }
        if (pins.length >= MAX_PINS) { setProblem(`You can follow at most ${MAX_PINS} fields. Stop following one first.`); return }
        setPins([...pins, path])
        setDraft('')
    }

    return (
        <section aria-label="Followed fields" className="space-y-3" data-testid="followed-fields">
            <h3 className={`text-sm font-medium ${dark ? 'text-slate-300' : 'text-slate-700'}`}>Followed fields</h3>
            <p className={`text-xs ${muted}`}>
                Pick a field of the payload and see what it did across the events: a number as a line with its range, text and true/false as their most common values.
                The fields you pin in the Doctor's profile tab are followed here too.
            </p>

            <form className="flex flex-wrap items-end gap-2" onSubmit={(e) => { e.preventDefault(); add() }}>
                <label className={`text-sm ${strong}`}>
                    <span className="block mb-1">Field to follow</span>
                    <input list="followed-field-options" value={draft} onChange={(e) => { setDraft(e.target.value); setProblem('') }} placeholder="$.status" className={`${field} w-56`} data-testid="follow-input" />
                    <datalist id="followed-field-options">{known.map((p) => <option key={p} value={p} />)}</datalist>
                </label>
                <button type="submit" data-testid="follow-add" className={`px-3 py-1.5 rounded-lg text-sm font-medium flex items-center gap-1.5 ${dark ? 'bg-slate-700 text-slate-100 hover:bg-slate-600' : 'bg-slate-200 text-slate-900 hover:bg-slate-300'}`}>
                    <Plus className="w-4 h-4" aria-hidden="true" /> Follow
                </button>
                {loadHistory && (
                    <label className={`flex items-center gap-2 text-sm ${strong}`}>
                        <input type="checkbox" checked={useHistory} onChange={(e) => setUseHistory(e.target.checked)} data-testid="follow-history" />
                        Include saved history
                    </label>
                )}
            </form>
            {problem && <p role="alert" className={`text-sm ${dark ? 'text-red-300' : 'text-red-800'}`} data-testid="follow-problem">{problem}</p>}
            <p role="status" className={`text-xs ${muted}`} data-testid="follow-source">
                {loading ? 'Reading the saved history…' : `Looking at the newest ${Math.min(source.length, MAX_EVENTS_LOOKED_AT).toLocaleString()} ${useHistory && history ? 'events of the saved history' : 'events held'}${source.length > MAX_EVENTS_LOOKED_AT ? ` (of ${source.length.toLocaleString()})` : ''}.`}
            </p>

            {summaries.length === 0 ? (
                <p className={`text-sm ${muted}`}>No fields followed yet.</p>
            ) : (
                <ul className="space-y-2" aria-label="Followed fields">
                    {summaries.map((s) => <Card key={s.path} summary={s} dark={dark} onRemove={() => setPins(pins.filter((p) => p !== s.path))} />)}
                </ul>
            )}
        </section>
    )
}
