import { lazy, Suspense, useEffect, useState } from 'react'
import { Share2, Stethoscope } from 'lucide-react'
import type { Theme } from '../../types'
import { useDoctorView } from '../../doctor/useDoctor'
import { useUIContext } from '../../context/UIContext'
import { useStreamContext } from '../../context/StreamContext'
import { isMockStreamUrl } from '../../doctor/mockReplay'
import { recordingEnabled } from '../../doctor/recordingConfig'
import { HealthStrip } from './HealthStrip'
import { FindingCard } from './FindingCard'
import { Tabs } from './Tabs'
import SequenceView from './SequenceView'
import TimelineView from './TimelineView'
import ProfileEditor from './ProfileEditor'

interface Props {
    theme: Theme
    streamId: string
    /** Heading text. */
    title?: string
    /** `h2` for the single-stream panel, `h3` inside a lane list. */
    heading?: 'h2' | 'h3'
}

// Everything the export needs (redaction, reports, scenarios) is fetched when the dialog opens.
const ExportDialog = lazy(() => import('./ExportDialog'))
// Saved and opened captures need the capture reader and the comparison, so they are fetched when the tab opens.
const CapturesTab = lazy(() => import('./CapturesTab'))

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
    const [exporting, setExporting] = useState(false)
    const [tab, setTab] = useState('findings')
    const { requestEventJump, jumpResult, url, setUrl, setUseProxy, setAppMode } = useUIContext()
    const { connect, disconnect } = useStreamContext()
    const showEvent = (seq: number) => requestEventJump(streamId, seq)
    const Heading = heading
    const sectionHeading = heading === 'h2' ? 'h3' : 'h4'
    // The profile is shared by every stream, so it is edited once: in the single-stream panel, and above the lane cards.
    const ownsProfile = heading === 'h2'
    const errors = view ? view.open.error + view.open.critical : 0
    const warnings = view?.open.warning ?? 0
    const announcement = useAnnouncement(view?.health.phase, errors, warnings)
    const muted = dark ? 'text-slate-300' : 'text-slate-700'

    const open = view?.findings.filter((f) => f.status === 'open') ?? []
    const resolved = view?.findings.filter((f) => f.status === 'resolved') ?? []
    const declared = view?.profile?.sequence !== undefined
    const replaying = ownsProfile && isMockStreamUrl(url)
    // A replay of an exported capture: the viewer is connected to the mock server, which plays the recording again.
    const watchReplay = (replayUrl: string) => {
        disconnect()
        setAppMode('monitor')
        setUseProxy(false) // the mock stream is on this origin
        setUrl(replayUrl)
        connect(replayUrl, '')
    }

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
                {view && (
                    <button
                        type="button"
                        onClick={() => setExporting(true)}
                        data-testid="doctor-export"
                        className={`ml-auto px-3 py-1.5 rounded-lg text-sm font-medium flex items-center gap-2 ${dark ? 'bg-slate-700 text-slate-100 hover:bg-slate-600' : 'bg-slate-200 text-slate-900 hover:bg-slate-300'}`}
                    >
                        <Share2 className="w-4 h-4" aria-hidden="true" /> Export…
                    </button>
                )}
            </div>
            <div role="status" aria-live="polite" className="sr-only">{announcement}</div>
            {replaying && (
                <p className={`text-sm rounded-lg p-3 ${dark ? 'bg-slate-800 text-slate-100' : 'bg-slate-100 text-slate-900'}`} data-testid="replay-banner">
                    This stream is a replay of a recording, served by the mock server. The timings, ids and event names are the recording's, but the bodies are placeholders and the timings are played back, not measured on a network, so what these checks say describes the recording, not a live server.
                </p>
            )}
            {exporting && view && (
                <Suspense fallback={null}>
                    <ExportDialog theme={theme} streamId={streamId} findings={view.findings} endT={view.nowT} {...(ownsProfile ? { onReplay: watchReplay } : {})} onClose={() => setExporting(false)} />
                </Suspense>
            )}

            {!view ? (
                <>
                    <p className={`text-sm ${muted}`} data-testid="doctor-empty">
                        {recordingEnabled()
                            ? 'Connect to a stream and its diagnosis appears here: how it connected, how bytes and events arrive, and what looks wrong.'
                            : 'Recording is switched off in this browser (localStorage "sse.recording" is "off"), so there is nothing to diagnose. Remove that setting and connect again.'}
                    </p>
                    {ownsProfile && (
                        <details>
                            <summary className={`cursor-pointer text-sm font-medium ${dark ? 'text-slate-100' : 'text-slate-900'}`}>Set up a profile before connecting</summary>
                            <div className="mt-3"><ProfileEditor theme={theme} /></div>
                        </details>
                    )}
                </>
            ) : (
                <>
                    <HealthStrip theme={theme} health={view.health} />

                    <Tabs
                        theme={theme}
                        label={`${title} sections`}
                        active={tab}
                        onChange={setTab}
                        tabs={[
                            { id: 'findings', label: 'Findings', badge: open.length > 0 ? String(open.length) : undefined },
                            { id: 'timeline', label: 'Timeline', badge: view.health.reconnects > 0 ? `${view.health.reconnects + 1} attempts` : undefined },
                            { id: 'sequence', label: 'Sequence', badge: declared ? 'declared' : undefined },
                            ...(ownsProfile ? [{ id: 'captures', label: 'Captures' }, { id: 'profile', label: 'Profile' }] : []),
                        ]}
                    >
                        {tab === 'findings' && (
                            <div className="space-y-4">
                                {jumpResult === 'missing' && (
                                    <p role="status" className={`text-sm ${dark ? 'text-amber-200' : 'text-amber-900'}`} data-testid="jump-missing">
                                        That event is not in the events list any more: the list keeps the latest 1000, or a filter hides it. The record above still has what was seen.
                                    </p>
                                )}
                                {jumpResult === 'found' && <p role="status" className="sr-only">The event is shown in the events list.</p>}
                                {open.length > 0 ? (
                                    <ul className="space-y-2" aria-label="Open findings">
                                        {open.map((f, i) => <FindingCard key={f.key} theme={theme} streamId={streamId} finding={f} sectionHeading={sectionHeading} onShowEvent={showEvent} defaultOpen={i === 0 && f.severity !== 'info'} />)}
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
                                            {resolved.map((f) => <FindingCard key={f.key} theme={theme} streamId={streamId} finding={f} sectionHeading={sectionHeading} onShowEvent={showEvent} />)}
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
                            </div>
                        )}
                        {tab === 'timeline' && <TimelineView theme={theme} streamId={streamId} view={view} />}
                        {tab === 'sequence' && <SequenceView theme={theme} streamId={streamId} view={view} {...(ownsProfile ? { onDeclare: () => setTab('profile') } : {})} />}
                        {tab === 'captures' && ownsProfile && (
                            <Suspense fallback={<p role="status" className={`text-sm ${muted}`}>Loading…</p>}>
                                <CapturesTab theme={theme} streamId={streamId} view={view} />
                            </Suspense>
                        )}
                        {tab === 'profile' && ownsProfile && <ProfileEditor theme={theme} />}
                    </Tabs>
                </>
            )}
        </section>
    )
}
