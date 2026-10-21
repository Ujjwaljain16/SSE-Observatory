import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { FolderOpen, Save, Trash2 } from 'lucide-react'
import type { Theme } from '../../types'
import type { Observation } from '../../core/observe/observation'
import { analyze } from '../../core/diagnostics/engine'
import type { EngineInput } from '../../core/diagnostics/streamModel'
import { captureEndT, serializeCapture, type Capture } from '../../core/capture/format'
import { compareCaptures } from '../../core/capture/derived/compare'
import { describeProfile } from '../../core/diagnostics/profile'
import { addBookmark, deleteCapture, listBookmarks, listCaptures, readCaptureText, saveCapture, type Bookmark, type SavedCaptureMeta } from '../../doctor/captureLibrary'
import { captureOf } from '../../doctor/captureOf'
import { loadCaptureText } from '../../doctor/loadCapture'
import { getProfile } from '../../doctor/profileStore'
import type { DoctorView } from '../../doctor/doctorSession'
import { fmtBytes, fmtDuration } from './format'
import { FindingCard } from './FindingCard'

interface Props {
    theme: Theme
    streamId: string
    view: DoctorView
}

/** A capture in the list: saved in the library, or opened from a file and not kept. */
interface Item {
    key: string
    name: string
    records: number
    bytes: number
    origin: 'recording' | 'file'
    saved: boolean
    /** Loads the capture when asked, so a long list costs nothing. */
    load: () => Promise<Capture | string>
}

export default function CapturesTab({ theme, streamId, view }: Props) {
    const dark = theme === 'dark'
    const muted = dark ? 'text-slate-300' : 'text-slate-700'
    const strong = dark ? 'text-white' : 'text-slate-900'
    const button = `px-3 py-1.5 rounded-lg text-sm font-medium flex items-center gap-2 disabled:opacity-50 ${dark ? 'bg-slate-700 text-slate-100 hover:bg-slate-600' : 'bg-slate-200 text-slate-900 hover:bg-slate-300'}`
    const field = `rounded-lg border px-2 py-1 text-sm ${dark ? 'bg-slate-800 border-slate-600 text-white' : 'bg-white border-slate-300 text-slate-900'}`

    const [saved, setSaved] = useState<SavedCaptureMeta[]>([])
    const [opened, setOpened] = useState<Array<Item & { capture: Capture }>>([])
    const [name, setName] = useState('')
    const [notice, setNotice] = useState('')
    const [error, setError] = useState('')
    const [viewing, setViewing] = useState<{ title: string; capture: Capture; marks: Bookmark[] } | null>(null)
    const [pair, setPair] = useState<string[]>([])
    const [comparison, setComparison] = useState<{ title: string; findings: ReturnType<typeof compareCaptures> } | null>(null)
    const input = useRef<HTMLInputElement>(null)

    const refresh = useCallback(async () => {
        try { setSaved(await listCaptures()) } catch (err) { setError(err instanceof Error ? err.message : String(err)) }
    }, [])
    useEffect(() => { void refresh() }, [refresh])

    const items: Item[] = useMemo(() => [
        ...opened,
        ...saved.map((s): Item => ({
            key: s.id, name: s.name, records: s.records, bytes: s.bytes, origin: s.origin, saved: true,
            load: async () => {
                const text = await readCaptureText(s.id)
                return text ?? 'That capture is no longer in the library.'
            },
        })),
    ], [opened, saved])

    const capture = async (item: Item): Promise<Capture | undefined> => {
        const loaded = await item.load()
        if (typeof loaded !== 'string' && 'header' in loaded) return loaded
        const result = loadCaptureText(typeof loaded === 'string' ? loaded : '')
        if (!result.ok) { setError(result.error); return undefined }
        return result.capture
    }

    const saveCurrent = async () => {
        setError(''); setNotice('')
        const snapshot = captureOf(streamId, view.nowT, getProfile())
        if (!snapshot) { setError('There is nothing recorded yet.'); return }
        try {
            const text = serializeCapture(snapshot.capture)
            const label = name.trim() || `${snapshot.capture.header.request?.url ?? 'Recording'} · ${new Date().toLocaleTimeString()}`
            const savedMeta = await saveCapture({ name: label, text, records: snapshot.capture.records.length, origin: 'recording' })
            // bookmarks made while looking at this recording go with it
            for (const m of await listBookmarks(view.captureId ?? streamId)) await addBookmark({ captureId: savedMeta.id, label: m.label, t: m.t })
            setName('')
            setNotice(`Saved. It is kept in this browser only and is not redacted.${snapshot.truncated ? ' The recording had folded older detail away, so it is not the whole stream.' : ''}`)
            await refresh()
        } catch (err) { setError(err instanceof Error ? err.message : String(err)) }
    }

    const openFile = async (file: File) => {
        setError(''); setNotice('')
        const result = loadCaptureText(await file.text(), file.size)
        if (!result.ok) { setError(`${file.name}: ${result.error}`); return }
        const text = `${result.format === 'sse-record' ? 'Older recording' : 'Capture'} opened: ${file.name}.`
        const note = [text, ...result.warnings, ...(result.integrity === 'mismatch' ? ['The file does not match its own integrity hash: it was changed after it was written, or damaged.'] : [])].join(' ')
        const item = { key: `file:${file.name}:${file.lastModified}`, name: file.name, records: result.capture.records.length, bytes: file.size, origin: 'file' as const, saved: false, load: async () => result.capture, capture: result.capture }
        setOpened((o) => [item, ...o.filter((x) => x.key !== item.key)])
        setNotice(note)
    }

    const analyse = async (item: Item) => {
        setError(''); setComparison(null)
        const c = await capture(item)
        if (c) {
            let marks: Bookmark[] = []
            if (item.saved) { try { marks = await listBookmarks(item.key) } catch { /* the library is unavailable: show the analysis without them */ } }
            setViewing({ title: item.name, capture: c, marks })
        }
    }

    const remove = async (item: Item) => {
        if (item.saved) { await deleteCapture(item.key); await refresh() } else setOpened((o) => o.filter((x) => x.key !== item.key))
        setPair((p) => p.filter((k) => k !== item.key))
    }

    const compare = async () => {
        setError(''); setViewing(null)
        const [a, b] = pair.map((key) => items.find((i) => i.key === key))
        if (!a || !b) return
        const [ca, cb] = [await capture(a), await capture(b)]
        if (ca && cb) setComparison({ title: `${a.name} and ${b.name}`, findings: compareCaptures(ca, cb) })
    }

    const togglePair = (key: string) => setPair((p) => p.includes(key) ? p.filter((k) => k !== key) : [...p, key].slice(-2))

    return (
        <section aria-label="Captures" className="space-y-5" data-testid="doctor-captures">
            <p className={`text-sm ${muted}`}>
                Keep a recording to look at later, open one from a file (an <code>.sse-capture</code> from the command line or a teammate, or an older <code>.sse-record</code>), and compare two to see where
                their behaviour differs. Saved captures stay in this browser and are not redacted; share one only through Export.
            </p>

            <div className="flex flex-wrap items-end gap-3">
                <label className={`text-sm ${strong}`}>
                    <span className="block mb-1">Name for this recording</span>
                    <input value={name} onChange={(e) => setName(e.target.value)} placeholder="optional" className={`${field} w-64`} data-testid="capture-name" />
                </label>
                <button type="button" onClick={() => void saveCurrent()} className={button} data-testid="capture-save"><Save className="w-4 h-4" aria-hidden="true" /> Save this recording</button>
                <button type="button" onClick={() => input.current?.click()} className={button} data-testid="capture-open"><FolderOpen className="w-4 h-4" aria-hidden="true" /> Open a file…</button>
                <input ref={input} type="file" accept=".sse-capture,.sse-record,.json,.ndjson" className="sr-only" tabIndex={-1} aria-label="Capture file" data-testid="capture-file" onChange={(e) => { const f = e.target.files?.[0]; if (f) void openFile(f); e.target.value = '' }} />
            </div>

            {error && <p role="alert" className={`text-sm ${dark ? 'text-red-300' : 'text-red-800'}`} data-testid="capture-error">{error}</p>}
            <p role="status" className={`text-sm ${strong}`} data-testid="capture-notice">{notice}</p>

            {items.length === 0 ? (
                <p className={`text-sm ${muted}`}>Nothing saved or opened yet.</p>
            ) : (
                <div>
                    <table className="w-full text-sm" data-testid="capture-list">
                        <caption className={`text-left font-semibold mb-1 ${strong}`}>Captures</caption>
                        <thead>
                            <tr className={`text-left ${muted}`}>
                                <th scope="col" className="py-1 pr-3">Compare</th><th scope="col" className="py-1 pr-3">Name</th><th scope="col" className="py-1 pr-3">Records</th><th scope="col" className="py-1 pr-3">Size</th><th scope="col" className="py-1 pr-3">Kept</th><th scope="col" className="py-1"><span className="sr-only">Actions</span></th>
                            </tr>
                        </thead>
                        <tbody className={strong}>
                            {items.map((item) => (
                                <tr key={item.key} className={`border-t ${dark ? 'border-slate-700' : 'border-slate-200'}`}>
                                    <td className="py-1 pr-3"><input type="checkbox" aria-label={`Compare ${item.name}`} checked={pair.includes(item.key)} onChange={() => togglePair(item.key)} /></td>
                                    <th scope="row" className="py-1 pr-3 text-left font-medium">{item.name}</th>
                                    <td className="py-1 pr-3 tabular-nums">{item.records.toLocaleString()}</td>
                                    <td className="py-1 pr-3 tabular-nums">{fmtBytes(item.bytes)}</td>
                                    <td className="py-1 pr-3">{item.saved ? `in this browser${item.origin === 'file' ? ' (from a file)' : ''}` : 'this visit only'}</td>
                                    <td className="py-1 flex gap-2">
                                        <button type="button" className={button} onClick={() => void analyse(item)} aria-label={`Analyse ${item.name}`}>Analyse</button>
                                        <button type="button" className={button} onClick={() => void remove(item)} aria-label={`${item.saved ? 'Delete' : 'Close'} ${item.name}`}><Trash2 className="w-4 h-4" aria-hidden="true" /></button>
                                    </td>
                                </tr>
                            ))}
                        </tbody>
                    </table>
                    <div className="mt-2 flex items-center gap-3">
                        <button type="button" className={button} disabled={pair.length !== 2} onClick={() => void compare()} data-testid="capture-compare">Compare the two selected</button>
                        <span className={`text-sm ${muted}`}>{pair.length === 2 ? '' : 'Tick two captures to compare them.'}</span>
                    </div>
                </div>
            )}

            {viewing && <Analysis theme={theme} title={viewing.title} capture={viewing.capture} marks={viewing.marks} />}

            {comparison && (
                <section aria-label={`Comparison of ${comparison.title}`} className="space-y-2" data-testid="capture-comparison">
                    <h3 className={`text-sm font-semibold ${strong}`}>Comparing {comparison.title}</h3>
                    <p className={`text-sm ${muted}`}>What differs between the two, as measurements first. Which layer caused a difference cannot be told from two recordings alone.</p>
                    {comparison.findings.length === 0 ? (
                        <p className={`text-sm ${strong}`}>No differences were found in what these checks compare. That is not proof the two streams behave the same.</p>
                    ) : (
                        <ul className="space-y-2" aria-label="Differences">
                            {comparison.findings.map((f) => <FindingCard key={f.key} theme={theme} streamId={streamId} finding={f} sectionHeading="h4" lookup={() => undefined} />)}
                        </ul>
                    )}
                </section>
            )}
        </section>
    )
}

/** The findings of one capture, analysed as the command line would. */
function Analysis({ theme, title, capture, marks }: { theme: Theme; title: string; capture: Capture; marks: Bookmark[] }) {
    const dark = theme === 'dark'
    const muted = dark ? 'text-slate-300' : 'text-slate-700'
    const strong = dark ? 'text-white' : 'text-slate-900'
    const analysis = useMemo(
        () => analyze(capture.records as EngineInput[], { endT: captureEndT(capture), ...(capture.header.profile ? { profile: capture.header.profile } : {}) }),
        [capture],
    )
    const records = useMemo(() => new Map(capture.records.map((r) => [r.seq, r as Observation])), [capture])
    const open = analysis.findings.filter((f) => f.status === 'open')
    const notEvaluated = analysis.coverage.filter((c) => c.status === 'not-evaluated')
    return (
        <section aria-label={`Analysis of ${title}`} className="space-y-3" data-testid="capture-analysis">
            <h3 className={`text-sm font-semibold ${strong}`}>{title}</h3>
            <p className={`text-sm ${muted}`}>
                {capture.header.kind === 'sanitized' ? 'Redacted capture' : 'Full capture'} of {capture.header.request?.url ?? 'an unknown request'}, {capture.records.length.toLocaleString()} records over {fmtDuration(captureEndT(capture))}
                {capture.header.profile ? `; profile: ${describeProfile(capture.header.profile)}` : '; no profile declared in the file'}.
            </p>
            {marks.length > 0 && (
                <p className={`text-sm ${muted}`} data-testid="capture-bookmarks">Bookmarks: {marks.map((m) => `${m.label} (${fmtDuration(m.t)})`).join('; ')}.</p>
            )}
            {open.length === 0 ? (
                <p className={`text-sm ${strong}`} data-testid="capture-no-findings">No findings. {notEvaluated.length > 0 ? `${notEvaluated.length} check${notEvaluated.length === 1 ? ' was' : 's were'} not evaluated because the capture lacks what they need, so this is not proof it is healthy.` : 'That is not proof it is healthy.'}</p>
            ) : (
                <ul className="space-y-2" aria-label="Findings in this capture">
                    {open.map((f) => <FindingCard key={f.key} theme={theme} streamId="" finding={f} sectionHeading="h4" lookup={(seq) => records.get(seq)} />)}
                </ul>
            )}
            {notEvaluated.length > 0 && (
                <details>
                    <summary className={`cursor-pointer text-sm font-medium ${strong}`}>Not evaluated ({notEvaluated.length})</summary>
                    <ul className={`mt-2 space-y-1 text-sm ${muted}`}>{notEvaluated.map((c) => <li key={c.ruleId}><span className="font-medium">{c.title}</span>: {c.notes.join(' ')}</li>)}</ul>
                </details>
            )}
        </section>
    )
}
