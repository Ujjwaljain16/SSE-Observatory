import { useId, useState } from 'react'
import { AlertTriangle, Check, ChevronDown, ChevronRight, Copy, Info, XCircle } from 'lucide-react'
import type { Finding, Severity } from '../../core/diagnostics'
import type { Theme } from '../../types'
import { CONSUMER_SEQ_BASE, recordFor } from '../../doctor/recordLookup'
import { fmtDuration, SEVERITY_BORDER, SEVERITY_LABEL, SEVERITY_TEXT } from './format'

interface Props {
    theme: Theme
    streamId: string
    finding: Finding
    defaultOpen?: boolean
}

const ICON: Record<Severity, typeof Info> = { info: Info, warning: AlertTriangle, error: XCircle, critical: XCircle }

function EvidenceChip({ theme, streamId, seq, t, note }: { theme: Theme; streamId: string; seq: number; t: number; note?: string | undefined }) {
    const [shown, setShown] = useState(false)
    const dark = theme === 'dark'
    const id = useId()
    // Looked up when opened, not on every render: the record may have been folded away since the finding was raised.
    const record = shown ? recordFor(streamId, seq) : undefined
    const label = seq >= CONSUMER_SEQ_BASE ? `page sample ${Math.floor(seq - CONSUMER_SEQ_BASE)}` : `record #${Math.floor(seq)}`
    return (
        <span className="inline-block align-top">
            <button
                type="button"
                aria-expanded={shown}
                aria-controls={id}
                onClick={() => setShown(!shown)}
                className={`mr-1.5 mb-1 px-2 py-0.5 rounded text-xs font-mono ${dark ? 'bg-slate-700 text-slate-100 hover:bg-slate-600' : 'bg-slate-200 text-slate-900 hover:bg-slate-300'}`}
            >
                {label} · {fmtDuration(t)}{note ? ` · ${note}` : ''}
            </button>
            {shown && (
                <pre id={id} tabIndex={0} aria-label={`Raw record ${seq}`} className={`block my-1 p-2 rounded text-xs overflow-auto max-h-48 ${dark ? 'bg-slate-900 text-slate-200' : 'bg-slate-50 text-slate-800 border border-slate-200'}`}>
                    {record ? JSON.stringify(record, null, 2) : 'This record is no longer held: the recording keeps a bounded amount, and older detail is folded away first.'}
                </pre>
            )}
        </span>
    )
}

export function FindingCard({ theme, streamId, finding, defaultOpen = false }: Props) {
    const dark = theme === 'dark'
    const [open, setOpen] = useState(defaultOpen)
    const [copied, setCopied] = useState(false)
    const bodyId = useId()
    const Icon = ICON[finding.severity]
    const tone = SEVERITY_TEXT[finding.severity][dark ? 'dark' : 'light']
    const muted = dark ? 'text-slate-300' : 'text-slate-700'
    const strong = dark ? 'text-white' : 'text-slate-900'

    const copy = async (text: string) => {
        try { await navigator.clipboard.writeText(text); setCopied(true); setTimeout(() => setCopied(false), 1500) } catch { /* clipboard blocked: the command is still on screen */ }
    }

    return (
        <li className={`rounded-lg border border-l-4 ${SEVERITY_BORDER[finding.severity]} ${dark ? 'bg-slate-800/60 border-slate-700' : 'bg-white border-slate-200'} ${finding.status === 'resolved' ? 'opacity-80' : ''}`} data-testid="doctor-finding" data-finding-key={finding.key}>
            <button
                type="button"
                aria-expanded={open}
                aria-controls={bodyId}
                onClick={() => setOpen(!open)}
                className="w-full flex items-start gap-3 text-left px-4 py-3"
            >
                {open ? <ChevronDown className="w-4 h-4 mt-1 shrink-0" aria-hidden="true" /> : <ChevronRight className="w-4 h-4 mt-1 shrink-0" aria-hidden="true" />}
                <span className="min-w-0 flex-1">
                    <span className="flex flex-wrap items-center gap-2">
                        <span className={`inline-flex items-center gap-1 text-xs font-bold uppercase tracking-wide ${tone}`}>
                            <Icon className="w-3.5 h-3.5" aria-hidden="true" />{SEVERITY_LABEL[finding.severity]}
                        </span>
                        {finding.status === 'resolved' && <span className={`text-xs ${muted}`}>(resolved)</span>}
                        <span className={`font-semibold text-sm ${strong}`}>{finding.title}</span>
                    </span>
                    <span className={`block text-sm mt-0.5 ${muted}`}>{finding.summary}</span>
                </span>
            </button>

            {open && (
                <div id={bodyId} className="px-4 pb-4 pl-11 space-y-3 text-sm">
                    {finding.facts.length > 0 && (
                        <section aria-label="What was observed">
                            <h4 className={`text-xs font-bold uppercase tracking-wide mb-1 ${muted}`}>Observed</h4>
                            <ul className="space-y-2">
                                {finding.facts.map((fact, i) => (
                                    <li key={i} className={strong}>
                                        {fact.text}
                                        {fact.evidence.length > 0 && (
                                            <span className="block mt-1">
                                                {fact.evidence.slice(0, 6).map((e) => <EvidenceChip key={`${e.seq}-${e.note ?? ''}`} theme={theme} streamId={streamId} seq={e.seq} t={e.t} note={e.note} />)}
                                            </span>
                                        )}
                                    </li>
                                ))}
                            </ul>
                        </section>
                    )}

                    {finding.deductions.length > 0 && (
                        <section aria-label="What it suggests">
                            <h4 className={`text-xs font-bold uppercase tracking-wide mb-1 ${muted}`}>Inferred, not measured</h4>
                            <ul className="space-y-2">
                                {finding.deductions.map((d, i) => (
                                    <li key={i} className={strong}>
                                        {d.statement} <span className={muted}>(confidence: {d.confidence})</span>
                                        {d.alternatives.length > 0 && (
                                            <ul className={`list-disc pl-5 mt-1 ${muted}`}>
                                                {d.alternatives.map((a, j) => <li key={j}>Or: {a}</li>)}
                                            </ul>
                                        )}
                                    </li>
                                ))}
                            </ul>
                        </section>
                    )}

                    {finding.nextCheck && (
                        <section aria-label="What to check next">
                            <h4 className={`text-xs font-bold uppercase tracking-wide mb-1 ${muted}`}>Check next</h4>
                            <p className={strong}>{finding.nextCheck.description}</p>
                            {finding.nextCheck.command && (
                                <div className="flex items-start gap-2 mt-1">
                                    <code className={`flex-1 px-2 py-1 rounded text-xs break-all ${dark ? 'bg-slate-900 text-slate-200' : 'bg-slate-100 text-slate-900'}`}>{finding.nextCheck.command}</code>
                                    <button type="button" onClick={() => void copy(finding.nextCheck!.command!)} className={`px-2 py-1 rounded text-xs flex items-center gap-1 ${dark ? 'bg-slate-700 text-slate-100 hover:bg-slate-600' : 'bg-slate-200 text-slate-900 hover:bg-slate-300'}`}>
                                        {copied ? <Check className="w-3 h-3" aria-hidden="true" /> : <Copy className="w-3 h-3" aria-hidden="true" />}{copied ? 'Copied' : 'Copy'}
                                    </button>
                                </div>
                            )}
                        </section>
                    )}

                    {finding.limits.length > 0 && (
                        <section aria-label="What this cannot tell">
                            <h4 className={`text-xs font-bold uppercase tracking-wide mb-1 ${muted}`}>Limits</h4>
                            <ul className={`list-disc pl-5 space-y-0.5 ${muted}`}>{finding.limits.map((l, i) => <li key={i}>{l}</li>)}</ul>
                        </section>
                    )}

                    <p className={`text-xs ${muted}`}>
                        Rule {finding.ruleId} v{finding.ruleVersion} · first seen {fmtDuration(finding.firstSeenT)} into the capture · seen {finding.occurrences} time{finding.occurrences === 1 ? '' : 's'}
                    </p>
                </div>
            )}
        </li>
    )
}
