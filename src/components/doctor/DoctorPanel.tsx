import { useEffect, useState } from 'react'
import { Stethoscope } from 'lucide-react'
import type { Theme } from '../../types'
import { useDoctorView } from '../../doctor/useDoctor'
import { recordingEnabled } from '../../doctor/recordingConfig'
import { HealthStrip } from './HealthStrip'
import { FindingCard } from './FindingCard'

interface Props {
    theme: Theme
    streamId: string
    /** Heading text. */
    title?: string
    /** `h2` for the single-stream panel, `h3` inside a lane list. */
    heading?: 'h2' | 'h3'
}

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`

/** The announcement for assistive technology: only changes of state, never the ticking figures. */
function useAnnouncement(phase: string | undefined, errors: number, warnings: number): string {
    const [text, setText] = useState('')
    useEffect(() => {
        if (phase === undefined) return
        setText(`Connection ${phase === 'idle' ? 'not started' : phase}. ${plural(errors, 'error')}, ${plural(warnings, 'warning')} open.`)
    }, [phase, errors, warnings])
    return text
}

export default function DoctorPanel({ theme, streamId, title = 'Stream Doctor', heading = 'h2' }: Props) {
    const dark = theme === 'dark'
    const view = useDoctorView(streamId)
    const Heading = heading
    const sectionHeading = heading === 'h2' ? 'h3' : 'h4'
    const errors = view ? view.open.error + view.open.critical : 0
    const warnings = view?.open.warning ?? 0
    const announcement = useAnnouncement(view?.health.phase, errors, warnings)
    const muted = dark ? 'text-slate-300' : 'text-slate-700'

    const open = view?.findings.filter((f) => f.status === 'open') ?? []
    const resolved = view?.findings.filter((f) => f.status === 'resolved') ?? []

    return (
        <section aria-label={title} data-testid="doctor-panel" className="space-y-4">
            <div className="flex flex-wrap items-center gap-3">
                <Stethoscope className={`w-5 h-5 ${dark ? 'text-teal-300' : 'text-teal-800'}`} aria-hidden="true" />
                <Heading className={`text-lg font-bold ${dark ? 'text-white' : 'text-slate-900'}`}>{title}</Heading>
                {view && (
                    <span className={`text-sm ${muted}`} data-testid="doctor-summary">
                        {open.length === 0 ? 'No open findings' : `${plural(open.length, 'open finding')}: ${plural(errors, 'error')}, ${plural(warnings, 'warning')}, ${plural(view.open.info, 'note')}`}
                    </span>
                )}
            </div>
            <div role="status" aria-live="polite" className="sr-only">{announcement}</div>

            {!view ? (
                <p className={`text-sm ${muted}`} data-testid="doctor-empty">
                    {recordingEnabled()
                        ? 'Connect to a stream and its diagnosis appears here: how it connected, how bytes and events arrive, and what looks wrong.'
                        : 'Recording is switched off in this browser (localStorage "sse.recording" is "off"), so there is nothing to diagnose. Remove that setting and connect again.'}
                </p>
            ) : (
                <>
                    <HealthStrip theme={theme} health={view.health} />

                    {open.length > 0 ? (
                        <ul className="space-y-2" aria-label="Open findings">
                            {open.map((f, i) => <FindingCard key={f.key} theme={theme} streamId={streamId} finding={f} sectionHeading={sectionHeading} defaultOpen={i === 0 && f.severity !== 'info'} />)}
                        </ul>
                    ) : (
                        <p className={`text-sm ${muted}`} data-testid="doctor-none">
                            No findings so far. {view.evaluated} of {view.evaluated + view.notEvaluated} checks could look at this stream
                            {view.notEvaluated > 0 ? `; ${view.notEvaluated} could not (listed below)` : ''}. No findings is not proof the stream is healthy: it only means nothing these checks look for has appeared yet.
                        </p>
                    )}

                    {resolved.length > 0 && (
                        <details>
                            <summary className={`cursor-pointer text-sm font-medium ${dark ? 'text-slate-100' : 'text-slate-900'}`}>Resolved ({resolved.length})</summary>
                            <ul className="space-y-2 mt-2" aria-label="Resolved findings">
                                {resolved.map((f) => <FindingCard key={f.key} theme={theme} streamId={streamId} finding={f} sectionHeading={sectionHeading} />)}
                            </ul>
                        </details>
                    )}

                    <details>
                        <summary className={`cursor-pointer text-sm font-medium ${dark ? 'text-slate-100' : 'text-slate-900'}`}>
                            What was checked ({view.evaluated} checked, {view.notEvaluated} not evaluated)
                        </summary>
                        <ul className="mt-2 space-y-1 text-sm">
                            {view.coverage.map((c) => (
                                <li key={c.ruleId} className={dark ? 'text-slate-200' : 'text-slate-800'}>
                                    <span className="font-medium">{c.title}</span>{' '}
                                    <span className={muted}>({c.ruleId}): {c.status === 'evaluated' ? 'checked' : 'not evaluated'}</span>
                                    {c.notes.map((n, i) => <span key={i} className={`block text-xs ${muted}`}>{n}</span>)}
                                </li>
                            ))}
                        </ul>
                    </details>
                </>
            )}
        </section>
    )
}
