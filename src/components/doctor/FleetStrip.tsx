import { useMemo } from 'react'
import { Download } from 'lucide-react'
import type { Theme } from '../../types'
import type { DoctorView } from '../../doctor/doctorSession'
import { downloadText } from '../../doctor/download'
import { buildFleet, fleetJson } from '../../doctor/fleet'
import { formatRate } from '../../utils/eventStats'
import { fmtAge, fmtBytes, fmtDuration } from './format'

interface Props {
    theme: Theme
    lanes: ReadonlyArray<{ id: string; name: string }>
    views: ReadonlyMap<string, DoctorView>
    /** Events per second across the lanes, when the caller measures it. */
    ratePerSecond?: number | undefined
}

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`

/** All the lanes of Multi-Stream at a glance: how many are up, how fast events arrive, what is open, and which lane to look at first. */
export default function FleetStrip({ theme, lanes, views, ratePerSecond }: Props) {
    const dark = theme === 'dark'
    const muted = dark ? 'text-slate-300' : 'text-slate-700'
    const strong = dark ? 'text-white' : 'text-slate-900'
    const fleet = useMemo(() => buildFleet(lanes, views), [lanes, views])
    if (lanes.length === 0) return null

    const phases = Object.entries(fleet.byPhase).sort((a, b) => b[1] - a[1]).map(([p, n]) => `${n} ${p}`).join(', ')
    const openText = (['critical', 'error', 'warning', 'info'] as const).filter((s) => fleet.open[s] > 0).map((s) => plural(fleet.open[s], s === 'info' ? 'note' : s)).join(', ')
    const items: Array<{ label: string; value: string; note?: string | undefined }> = [
        { label: 'Lanes', value: String(lanes.length), note: phases },
        { label: 'Events', value: fleet.events.toLocaleString(), note: ratePerSecond !== undefined ? formatRate(ratePerSecond) : undefined },
        { label: 'Open findings', value: openText || 'none', note: fleet.worst ? `worst: ${fleet.worst}` : 'not proof of health' },
        { label: 'Longest since an event', value: fleet.stalest ? fmtDuration(fleet.stalest.ageMs) : '–', note: fleet.stalest ? `${fleet.stalest.name} (open lanes only)` : 'no open lane has had an event' },
        { label: 'Slowest page processing', value: fleet.slowest ? `p95 ${fmtDuration(fleet.slowest.p95LagMs)}` : 'not measured', note: fleet.slowest?.name },
        { label: 'Reconnects', value: fleet.reconnects.toLocaleString() },
        { label: 'Recorded', value: fmtBytes(fleet.retainedBytes) },
    ]

    return (
        <section aria-label="Fleet" className="space-y-3" data-testid="fleet-strip">
            <div className="flex flex-wrap items-center gap-3">
                <h3 className={`text-sm font-semibold ${strong}`}>Fleet</h3>
                <button
                    type="button"
                    data-testid="fleet-save"
                    onClick={() => downloadText('sse-fleet.json', fleetJson(fleet, new Date(), ratePerSecond), 'application/json')}
                    className={`ml-auto px-3 py-1.5 rounded-lg text-sm font-medium flex items-center gap-2 ${dark ? 'bg-slate-700 text-slate-100 hover:bg-slate-600' : 'bg-slate-200 text-slate-900 hover:bg-slate-300'}`}
                >
                    <Download className="w-4 h-4" aria-hidden="true" /> Save summary (JSON)
                </button>
            </div>
            <dl aria-label="Fleet figures" className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-2">
                {items.map(({ label, value, note }) => (
                    <div key={label} className={`rounded-lg px-3 py-2 ${dark ? 'bg-slate-800' : 'bg-slate-100'}`} data-testid={`fleet-${label.toLowerCase().replace(/[^a-z]+/g, '-')}`}>
                        <dt className={`text-xs ${muted}`}>{label}</dt>
                        <dd className={`text-sm font-semibold tabular-nums ${strong}`}>{value}</dd>
                        {note && <dd className={`text-xs ${muted}`}>{note}</dd>}
                    </div>
                ))}
            </dl>
            <details>
                <summary className={`cursor-pointer text-sm font-medium ${strong}`}>Per lane</summary>
                <table className="mt-2 w-full text-sm" data-testid="fleet-table">
                    <caption className="sr-only">Each lane's state and counts</caption>
                    <thead>
                        <tr className={`text-left ${muted}`}>{['Lane', 'State', 'Events', 'Since last event', 'Reconnects', 'Page p95', 'Open findings'].map((h) => <th key={h} scope="col" className="py-1 pr-3">{h}</th>)}</tr>
                    </thead>
                    <tbody className={strong}>
                        {fleet.lanes.map((l) => (
                            <tr key={l.id} className={`border-t ${dark ? 'border-slate-700' : 'border-slate-200'}`}>
                                <th scope="row" className="py-1 pr-3 text-left font-medium">{l.name}</th>
                                <td className="py-1 pr-3">{l.phase}</td>
                                <td className="py-1 pr-3 tabular-nums">{l.events.toLocaleString()}</td>
                                <td className="py-1 pr-3 tabular-nums">{fmtAge(l.lastEventAgeMs)}</td>
                                <td className="py-1 pr-3 tabular-nums">{l.reconnects}</td>
                                <td className="py-1 pr-3 tabular-nums">{l.p95LagMs === null ? '–' : fmtDuration(l.p95LagMs)}</td>
                                <td className="py-1">{l.worst ? `${plural(l.open.critical + l.open.error + l.open.warning + l.open.info, 'finding')} (worst ${l.worst})` : 'none'}</td>
                            </tr>
                        ))}
                    </tbody>
                </table>
            </details>
        </section>
    )
}
