import { useCallback, useEffect, useMemo, useState } from 'react'
import { Bookmark as BookmarkIcon, Trash2 } from 'lucide-react'
import type { Theme } from '../../types'
import type { DoctorView } from '../../doctor/doctorSession'
import { observationRegistry } from '../../doctor/observationRegistry'
import { buildTimeline } from '../../doctor/timeline'
import { addBookmark, deleteBookmark, listBookmarks, type Bookmark } from '../../doctor/captureLibrary'
import { fmtDuration } from './format'

interface Props {
    theme: Theme
    streamId: string
    view: DoctorView
}

const MAX_ROWS = 50
const ROW = 26
const LEFT = 46
const WIDTH = 820

export default function TimelineView({ theme, streamId, view }: Props) {
    const dark = theme === 'dark'
    const muted = dark ? 'text-slate-300' : 'text-slate-700'
    const strong = dark ? 'text-white' : 'text-slate-900'

    // Rebuilt when the recording changes (the record count says so), not on every tick.
    const timeline = useMemo(
        () => buildTimeline(observationRegistry.get(streamId)?.store.snapshot() ?? [], view.nowT),
        [streamId, view.health.capture.records, view.nowT], // eslint-disable-line react-hooks/exhaustive-deps -- nowT moves the open connection's end
    )
    const captureId = view.captureId ?? streamId
    const [marks, setMarks] = useState<Bookmark[]>([])
    const [label, setLabel] = useState('')
    const [problem, setProblem] = useState('')
    const reload = useCallback(async () => {
        try { setMarks(await listBookmarks(captureId)) } catch (err) { setProblem(err instanceof Error ? err.message : String(err)) }
    }, [captureId])
    useEffect(() => { void reload() }, [reload])
    const mark = async () => {
        setProblem('')
        try {
            await addBookmark({ captureId, label: label || `At ${fmtDuration(view.nowT)}`, t: view.nowT })
            setLabel('')
            await reload()
        } catch (err) { setProblem(err instanceof Error ? err.message : String(err)) }
    }
    const shown = timeline.connections.slice(-MAX_ROWS)
    const span = Math.max(timeline.endT, 1)
    const x = (t: number) => LEFT + (Math.max(0, Math.min(t, span)) / span) * (WIDTH - LEFT - 10)
    const height = shown.length * ROW + 34

    if (timeline.connections.length === 0) {
        return <p className={`text-sm ${muted}`} data-testid="doctor-timeline">Nothing recorded yet. Each connection attempt appears here as a row once the stream starts.</p>
    }

    const bar = dark ? 'fill-teal-500' : 'fill-teal-600'
    const failed = dark ? 'fill-red-400' : 'fill-red-600'
    const tick = dark ? 'stroke-white' : 'stroke-slate-900'
    const grid = dark ? 'stroke-slate-600' : 'stroke-slate-300'
    const label_ = dark ? 'fill-slate-200' : 'fill-slate-800'

    return (
        <section aria-label="Reconnect timeline" className="space-y-3" data-testid="doctor-timeline">
            <p className={`text-sm ${muted}`}>
                One row per connection attempt. The bar is how long the connection lived; each tick is an event, each dot a comment line
                (filled: from the origin, hollow: from the proxy). The dashed line is the wait before the next attempt. The table below
                says the same in words.
            </p>
            {timeline.connections.length > shown.length && (
                <p className={`text-sm ${muted}`}>Showing the latest {shown.length} of {timeline.connections.length} attempts.</p>
            )}

            <div className="overflow-x-auto">
                <svg role="img" aria-label={`Timeline of ${timeline.connections.length} connection attempt${timeline.connections.length === 1 ? '' : 's'} over ${fmtDuration(timeline.endT)}`} viewBox={`0 0 ${WIDTH} ${height}`} className="w-full min-w-[640px]" style={{ maxHeight: 560 }}>
                    {[0, 0.25, 0.5, 0.75, 1].map((f) => (
                        <g key={f}>
                            <line x1={x(span * f)} x2={x(span * f)} y1={14} y2={height - 6} className={grid} strokeWidth="1" strokeDasharray="2 4" />
                            <text x={x(span * f)} y={10} textAnchor={f === 1 ? 'end' : f === 0 ? 'start' : 'middle'} className={label_} fontSize="10">{fmtDuration(span * f)}</text>
                        </g>
                    ))}
                    {marks.map((m) => (
                        <g key={m.id}>
                            <line x1={x(m.t)} x2={x(m.t)} y1={14} y2={height - 6} className={dark ? 'stroke-teal-300' : 'stroke-teal-700'} strokeWidth="2" strokeDasharray="6 3" />
                            <text x={x(m.t) + 3} y={height - 8} className={label_} fontSize="10">{m.label.slice(0, 24)}</text>
                        </g>
                    ))}
                    {shown.map((c, i) => {
                        const y = 22 + i * ROW
                        const end = c.endT ?? timeline.endT
                        const ok = c.status === undefined || (c.status >= 200 && c.status < 300)
                        const next = shown[i + 1]
                        return (
                            <g key={c.conn}>
                                <text x={4} y={y + 11} className={label_} fontSize="11">#{c.attempt + 1}</text>
                                <rect x={x(c.startT)} y={y} width={Math.max(2, x(end) - x(c.startT))} height={14} rx={3} className={ok ? bar : failed} opacity={ok ? 0.55 : 0.8} />
                                {!ok && <text x={x(c.startT) + 4} y={y + 11} className={label_} fontSize="10">{c.status}</text>}
                                {c.events.slice(0, 600).map((t, k) => <line key={k} x1={x(t)} x2={x(t)} y1={y} y2={y + 14} className={tick} strokeWidth="1" />)}
                                {c.heartbeats.slice(0, 300).map((h, k) => (
                                    <circle key={k} cx={x(h.t)} cy={y + 7} r={2.2} className={h.source === 'upstream' ? (dark ? 'fill-amber-300' : 'fill-amber-700') : (dark ? 'stroke-amber-300' : 'stroke-amber-700')} fill={h.source === 'upstream' ? undefined : 'none'} strokeWidth="1" />
                                ))}
                                {c.endT !== undefined && next && (
                                    <line x1={x(c.endT)} x2={x(next.startT)} y1={y + 7} y2={y + 7 + ROW} className={grid} strokeWidth="1.5" strokeDasharray="4 3" />
                                )}
                            </g>
                        )
                    })}
                </svg>
            </div>

            <section aria-label="Bookmarks" className="space-y-2" data-testid="doctor-bookmarks">
                <h3 className={`text-sm font-semibold ${strong}`}>Bookmarks</h3>
                <div className="flex flex-wrap items-end gap-2">
                    <label className={`text-sm ${strong}`}>
                        <span className="block mb-1">Mark this moment</span>
                        <input value={label} onChange={(e) => setLabel(e.target.value)} placeholder="what happened (optional)" className={`rounded-lg border px-2 py-1 text-sm w-64 ${dark ? 'bg-slate-800 border-slate-600 text-white placeholder-slate-400' : 'bg-white border-slate-300 text-slate-900 placeholder-slate-500'}`} data-testid="bookmark-label" />
                    </label>
                    <button type="button" onClick={() => void mark()} data-testid="bookmark-add" className={`px-3 py-1.5 rounded-lg text-sm font-medium flex items-center gap-2 ${dark ? 'bg-slate-700 text-slate-100 hover:bg-slate-600' : 'bg-slate-200 text-slate-900 hover:bg-slate-300'}`}><BookmarkIcon className="w-4 h-4" aria-hidden="true" /> Add bookmark</button>
                </div>
                {problem && <p role="alert" className={`text-sm ${dark ? 'text-red-300' : 'text-red-800'}`}>{problem}</p>}
                {marks.length > 0 && (
                    <ul className={`text-sm ${strong}`} data-testid="bookmark-list">
                        {marks.map((m) => (
                            <li key={m.id} className="flex items-center gap-2">
                                <span className="tabular-nums">{fmtDuration(m.t)}</span> <span>{m.label}</span>
                                <button type="button" aria-label={`Delete bookmark ${m.label}`} onClick={() => void deleteBookmark(m.id).then(reload)} className={`p-1 rounded ${dark ? 'hover:bg-slate-700' : 'hover:bg-slate-100'}`}><Trash2 className="w-3.5 h-3.5" aria-hidden="true" /></button>
                            </li>
                        ))}
                    </ul>
                )}
                <p className={`text-xs ${muted}`}>Bookmarks stay in this browser with this recording, appear on the timeline, and are copied when you save the recording to the library.</p>
            </section>

            <table className="w-full text-sm" data-testid="timeline-table">
                <caption className="sr-only">Every connection attempt and what happened to it</caption>
                <thead>
                    <tr className={`text-left ${muted}`}>
                        {['Attempt', 'Started', 'Response', 'First event', 'Lived', 'Events', 'Comments', 'Longest wait for bytes', 'Ended', 'Resumed from id', 'Then waited'].map((h) => <th key={h} scope="col" className="py-1 pr-3 align-bottom">{h}</th>)}
                    </tr>
                </thead>
                <tbody className={strong}>
                    {shown.map((c) => (
                        <tr key={c.conn} className={`border-t ${dark ? 'border-slate-700' : 'border-slate-200'}`}>
                            <th scope="row" className="py-1 pr-3 text-left font-semibold">#{c.attempt + 1}</th>
                            <td className="py-1 pr-3 tabular-nums">{fmtDuration(c.startT)}</td>
                            <td className="py-1 pr-3 tabular-nums">{c.status !== undefined ? `${c.status}${c.responseT !== undefined ? ` after ${fmtDuration(c.responseT - c.startT)}` : ''}` : 'none'}</td>
                            <td className="py-1 pr-3 tabular-nums">{c.firstEventT !== undefined ? `after ${fmtDuration(c.firstEventT - c.startT)}` : 'none'}</td>
                            <td className="py-1 pr-3 tabular-nums">{fmtDuration((c.endT ?? timeline.endT) - c.startT)}{c.endT === undefined ? ' (open)' : ''}</td>
                            <td className="py-1 pr-3 tabular-nums">{c.events.length.toLocaleString()}</td>
                            <td className="py-1 pr-3 tabular-nums">{c.heartbeats.length.toLocaleString()}</td>
                            <td className="py-1 pr-3 tabular-nums">{c.bytes > 0 ? fmtDuration(c.longestGapMs) : '–'}</td>
                            <td className="py-1 pr-3">{c.endT === undefined ? 'still open' : (c.endReason ?? 'closed')}</td>
                            <td className="py-1 pr-3 tabular-nums">{c.sentLastEventId || (c.attempt === 0 ? '–' : 'none sent')}</td>
                            <td className="py-1 tabular-nums">{c.reconnectDelayMs !== undefined ? fmtDuration(c.reconnectDelayMs) : '–'}{c.serverRetryMs !== undefined ? ` (server asked ${fmtDuration(c.serverRetryMs)})` : ''}</td>
                        </tr>
                    ))}
                </tbody>
            </table>
        </section>
    )
}
