import { useEffect, useMemo, useRef, useState } from 'react'
import { Download, X } from 'lucide-react'
import type { Finding } from '../../core/diagnostics/finding'
import type { Theme } from '../../types'
import { ARTIFACTS, prepare, type ArtifactKind, type Prepared } from '../../doctor/artifacts'
import { captureOf } from '../../doctor/captureOf'
import { getProfile } from '../../doctor/profileStore'
import { downloadText } from '../../doctor/download'
import { useModalFocus } from '../../hooks/useModalFocus'

interface Props {
    theme: Theme
    streamId: string
    findings: Finding[]
    /** When the export is taken, in the recording's clock. */
    endT: number
    onClose: () => void
}

const PREVIEW_CHARS = 4000

export default function ExportDialog({ theme, streamId, findings, endT, onClose }: Props) {
    const dark = theme === 'dark'
    const dialogRef = useRef<HTMLDivElement>(null)
    useModalFocus(dialogRef, true, onClose)

    // The recording as it is when the dialog opens; later records do not change what is previewed.
    const snapshot = useMemo(() => captureOf(streamId, endT, getProfile()), [streamId]) // eslint-disable-line react-hooks/exhaustive-deps -- taken once, on open
    const [kind, setKind] = useState<ArtifactKind>('report-md')
    const [shell, setShell] = useState<'posix' | 'powershell'>('posix')
    const [findingKey, setFindingKey] = useState(findings[0]?.key ?? '')
    const [reproFor, setReproFor] = useState<string | null>(null)
    const [acknowledged, setAcknowledged] = useState(false)

    const result = useMemo((): { prepared?: Prepared; error?: string } => {
        if (!snapshot) return { error: 'There is nothing recorded yet.' }
        if (kind === 'repro' && reproFor !== findingKey) return {}
        try {
            return { prepared: prepare(kind, snapshot.capture, { shell, findingKey }) }
        } catch (err) {
            return { error: err instanceof Error ? err.message : String(err) }
        }
    }, [snapshot, kind, shell, findingKey, reproFor])
    const { prepared, error } = result

    useEffect(() => { setAcknowledged(false) }, [kind, shell, findingKey, reproFor])

    const residual = prepared?.residual.length ?? 0
    const needsAck = prepared !== undefined && (!prepared.shareable || residual > 0)
    const canDownload = prepared !== undefined && (!needsAck || acknowledged)

    const muted = dark ? 'text-slate-300' : 'text-slate-700'
    const strong = dark ? 'text-white' : 'text-slate-900'
    const field = `rounded-lg border px-2 py-1 text-sm ${dark ? 'bg-slate-800 border-slate-600 text-white' : 'bg-white border-slate-300 text-slate-900'}`
    const byRule = prepared?.redaction ? Object.entries(prepared.redaction.byRule).sort() : []
    const choice = ARTIFACTS.find((a) => a.kind === kind)!

    return (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4" onClick={onClose}>
            <div className="absolute inset-0 bg-black/60" />
            <div
                ref={dialogRef}
                role="dialog"
                aria-modal="true"
                aria-labelledby="export-title"
                tabIndex={-1}
                data-testid="export-dialog"
                className={`relative w-full max-w-3xl max-h-[90vh] flex flex-col rounded-xl shadow-2xl border overflow-hidden outline-none ${dark ? 'bg-slate-900 border-slate-700' : 'bg-white border-slate-200'}`}
                onClick={(e) => e.stopPropagation()}
            >
                <div className={`flex items-center justify-between px-5 py-4 border-b ${dark ? 'border-slate-700' : 'border-slate-200'}`}>
                    <h2 id="export-title" className={`text-lg font-bold ${strong}`}>Export from the Doctor</h2>
                    <button type="button" onClick={onClose} aria-label="Close" className={`p-1 rounded ${dark ? 'hover:bg-slate-700 text-slate-200' : 'hover:bg-slate-100 text-slate-700'}`}>
                        <X className="w-5 h-5" aria-hidden="true" />
                    </button>
                </div>

                <div className="overflow-y-auto px-5 py-4 space-y-4">
                    {snapshot && (
                        <p className={`text-sm ${muted}`}>
                            Taken from the recording as it is now: {snapshot.capture.records.length.toLocaleString()} records.
                            {snapshot.truncated ? ' The recording is bounded and had to fold away older detail, so this is not the whole stream.' : ''}
                        </p>
                    )}

                    <fieldset>
                        <legend className={`text-sm font-semibold mb-2 ${strong}`}>What to export</legend>
                        <div className="space-y-2">
                            {ARTIFACTS.map((a) => (
                                <label key={a.kind} className={`flex gap-3 items-start rounded-lg border px-3 py-2 cursor-pointer ${kind === a.kind ? (dark ? 'border-teal-400 bg-slate-800' : 'border-teal-700 bg-teal-50') : (dark ? 'border-slate-700' : 'border-slate-200')}`}>
                                    <input type="radio" name="artifact" value={a.kind} checked={kind === a.kind} onChange={() => setKind(a.kind)} className="mt-1" />
                                    <span>
                                        <span className={`block text-sm font-medium ${strong}`}>
                                            {a.label}
                                            <span className={`ml-2 text-xs font-bold uppercase ${a.shareable ? (dark ? 'text-emerald-300' : 'text-emerald-800') : (dark ? 'text-amber-300' : 'text-amber-800')}`}>
                                                {a.shareable ? 'redacted' : 'local only'}
                                            </span>
                                        </span>
                                        <span className={`block text-xs ${muted}`}>{a.description}</span>
                                    </span>
                                </label>
                            ))}
                        </div>
                    </fieldset>

                    {kind === 'curl' && (
                        <label className={`flex items-center gap-2 text-sm ${strong}`}>Shell
                            <select value={shell} onChange={(e) => setShell(e.target.value as 'posix' | 'powershell')} className={field}>
                                <option value="posix">POSIX (bash, zsh)</option>
                                <option value="powershell">PowerShell</option>
                            </select>
                        </label>
                    )}

                    {kind === 'repro' && (
                        <div className="flex flex-wrap items-end gap-3">
                            <label className={`text-sm ${strong}`}>
                                <span className="block mb-1">Finding to keep</span>
                                <select value={findingKey} onChange={(e) => setFindingKey(e.target.value)} className={field} disabled={findings.length === 0}>
                                    {findings.length === 0 && <option value="">No findings yet</option>}
                                    {findings.map((f) => <option key={f.key} value={f.key}>{f.title}</option>)}
                                </select>
                            </label>
                            <button type="button" disabled={!findingKey} onClick={() => setReproFor(findingKey)} className="px-3 py-1.5 rounded-lg text-sm font-medium bg-teal-700 text-white hover:bg-teal-600 disabled:bg-slate-600">
                                Find the smallest capture
                            </button>
                        </div>
                    )}

                    {error && <p role="alert" className={`text-sm ${dark ? 'text-red-300' : 'text-red-800'}`}>{error}</p>}

                    {prepared && (
                        <section aria-label="Preview" className="space-y-3">
                            {!prepared.shareable ? (
                                <p role="note" className={`text-sm rounded-lg p-3 ${dark ? 'bg-amber-900/40 text-amber-100' : 'bg-amber-50 text-amber-900'}`}>
                                    This file is not redacted. It may contain URLs, header values and comment text exactly as they were received. Keep it on this machine; use a redacted export to share.
                                </p>
                            ) : (
                                <p className={`text-sm ${strong}`} data-testid="export-redaction">
                                    Redaction replaced {prepared.redaction?.placeholders ?? 0} value{prepared.redaction?.placeholders === 1 ? '' : 's'}
                                    {byRule.length > 0 ? ` (${byRule.map(([rule, n]) => `${rule}: ${n}`).join(', ')})` : ''}, each with a numbered placeholder that is the same everywhere in this file.
                                </p>
                            )}

                            {prepared.shareable && (
                                residual > 0 ? (
                                    <div role="alert" className={`text-sm rounded-lg p-3 ${dark ? 'bg-red-900/40 text-red-100' : 'bg-red-50 text-red-900'}`} data-testid="export-residual">
                                        <p className="font-semibold">{residual} thing{residual === 1 ? '' : 's'} may still be secret after redaction. The values are not shown here; look at them in the preview.</p>
                                        <ul className="list-disc pl-5 mt-1">
                                            {prepared.residual.slice(0, 20).map((h, i) => <li key={i}>{h.where}: looks like {h.rule}</li>)}
                                        </ul>
                                    </div>
                                ) : (
                                    <p className={`text-sm ${muted}`} data-testid="export-clean">A scan of the redacted file for anything that still looks like a secret found nothing. That is a check, not a guarantee.</p>
                                )
                            )}

                            {prepared.notes.length > 0 && (
                                <ul className={`list-disc pl-5 text-sm ${muted}`}>{prepared.notes.map((n, i) => <li key={i}>{n}</li>)}</ul>
                            )}

                            <pre tabIndex={0} aria-label={`Preview of ${prepared.filename}`} className={`p-3 rounded-lg text-xs overflow-auto max-h-56 whitespace-pre-wrap break-all ${dark ? 'bg-slate-950 text-slate-200' : 'bg-slate-50 text-slate-800 border border-slate-200'}`}>
                                {prepared.text.slice(0, PREVIEW_CHARS)}{prepared.text.length > PREVIEW_CHARS ? `\n… ${(prepared.text.length - PREVIEW_CHARS).toLocaleString()} more characters in the file` : ''}
                            </pre>

                            {needsAck && (
                                <label className={`flex gap-2 items-start text-sm ${strong}`}>
                                    <input type="checkbox" checked={acknowledged} onChange={(e) => setAcknowledged(e.target.checked)} className="mt-1" data-testid="export-ack" />
                                    {prepared.shareable
                                        ? 'I have looked at the preview and at what may still be secret, and this is safe to share.'
                                        : 'I understand this file may contain secrets and I will not share it.'}
                                </label>
                            )}
                        </section>
                    )}
                </div>

                <div className={`flex items-center justify-end gap-2 px-5 py-3 border-t ${dark ? 'border-slate-700' : 'border-slate-200'}`}>
                    <span className={`mr-auto text-xs ${muted}`}>{choice.shareable ? 'Nothing leaves your browser: the file is made here and saved to your computer.' : ''}</span>
                    <button type="button" onClick={onClose} className={`px-3 py-1.5 rounded-lg text-sm ${dark ? 'bg-slate-700 text-slate-100 hover:bg-slate-600' : 'bg-slate-200 text-slate-900 hover:bg-slate-300'}`}>Close</button>
                    <button
                        type="button"
                        disabled={!canDownload}
                        onClick={() => { if (prepared) downloadText(prepared.filename, prepared.text, prepared.mime) }}
                        data-testid="export-download"
                        className="px-3 py-1.5 rounded-lg text-sm font-medium bg-teal-700 text-white hover:bg-teal-600 disabled:bg-slate-600 disabled:cursor-not-allowed flex items-center gap-2"
                    >
                        <Download className="w-4 h-4" aria-hidden="true" /> Download
                    </button>
                </div>
            </div>
        </div>
    )
}
