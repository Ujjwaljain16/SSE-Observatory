import type { EventMessage, Theme } from '../types'
import { typeShares } from '../utils/eventStats'

/** Event types as horizontal bars: the name and the count in text (that is the data), the bar a quick comparison. */
export function TypeChart({ events, theme }: { events: readonly EventMessage[]; theme: Theme }) {
    const dark = theme === 'dark'
    const shares = typeShares(events)
    if (shares.length === 0) return null
    return (
        <div data-testid="type-chart">
            <div className={`text-sm font-medium mb-2 ${dark ? 'text-slate-300' : 'text-slate-700'}`}>Event types</div>
            <ul className="space-y-1.5" aria-label="Events by type">
                {shares.map((s) => (
                    <li key={s.type} className="flex items-center gap-3 text-xs" data-testid="type-row">
                        <span className={`w-40 shrink-0 truncate font-mono ${dark ? 'text-slate-200' : 'text-slate-800'}`} title={s.type}>{s.type}</span>
                        <span aria-hidden="true" className={`flex-1 h-3 rounded ${dark ? 'bg-slate-700' : 'bg-slate-200'}`}>
                            <span
                                className={`block h-3 rounded ${s.type === 'other' ? (dark ? 'bg-slate-400' : 'bg-slate-500') : (dark ? 'bg-sky-400' : 'bg-sky-700')}`}
                                style={{ width: `${Math.max(2, Math.round(s.share * 100))}%` }}
                            />
                        </span>
                        <span className={`w-28 shrink-0 text-right tabular-nums ${dark ? 'text-slate-200' : 'text-slate-800'}`}>
                            {s.count.toLocaleString()} ({Math.round(s.share * 100)}%)
                        </span>
                    </li>
                ))}
            </ul>
        </div>
    )
}
