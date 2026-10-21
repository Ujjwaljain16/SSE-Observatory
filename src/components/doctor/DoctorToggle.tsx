import { Stethoscope } from 'lucide-react'
import type { Theme } from '../../types'
import { useDoctorSummary } from '../../doctor/useDoctor'

interface Props {
    theme: Theme
    active: boolean
    onToggle: () => void
    /** The stream, or the lanes, whose findings the badge counts. Defaults to the main stream. */
    streams?: string | readonly string[]
}

/**
 * The button that opens the Doctor panel, with a badge for open errors (or warnings when there are none). It also keeps
 * the diagnostics running while the panel is closed, because it is subscribed.
 */
export function DoctorToggle({ theme, active, onToggle, streams }: Props) {
    const { errors, warnings } = useDoctorSummary(streams)
    const count = errors > 0 ? errors : warnings
    const kind = errors > 0 ? 'error' : 'warning'
    return (
        <button
            type="button"
            onClick={onToggle}
            aria-pressed={active}
            data-testid="doctor-toggle"
            className={`px-4 py-2 rounded-lg text-sm font-medium transition-colors flex items-center gap-2 ${active
                ? (errors > 0 ? 'bg-red-700' : 'bg-teal-700') + ' text-white'
                : theme === 'dark' ? 'bg-slate-700 text-slate-300 hover:bg-slate-600' : 'bg-slate-200 text-slate-700 hover:bg-slate-300'}`}
        >
            <Stethoscope className="w-4 h-4" aria-hidden="true" /> Doctor
            {count > 0 && (
                <span data-testid="doctor-badge" data-kind={kind} className={`ml-0.5 px-1.5 py-0.5 rounded-full text-xs font-bold ${kind === 'error' ? 'bg-red-700 text-white' : 'bg-amber-600 text-white'}`}>
                    {count}<span className="sr-only"> open {kind}{count === 1 ? '' : 's'}</span>
                </span>
            )}
        </button>
    )
}
