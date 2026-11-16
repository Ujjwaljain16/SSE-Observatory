import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Check, FlaskConical, X } from 'lucide-react'
import type { Theme } from '../../types'
import type { Observation } from '../../core/observe/observation'
import { analyze } from '../../core/diagnostics/engine'
import type { Finding } from '../../core/diagnostics/finding'
import type { EngineInput } from '../../core/diagnostics/streamModel'
import { captureEndT, parseCapture, type Capture } from '../../core/capture/format'
import { checkExpectations, type LabCheck } from '../../doctor/labCheck'
import { saveCapture } from '../../doctor/captureLibrary'
import { FindingCard } from './FindingCard'

interface Props {
    theme: Theme
    /** The library changed (a lab capture was saved), so the list should be read again. */
    onSaved: () => void
    /** Start expanded, and load the lab at once (the empty Doctor opens it this way). */
    defaultOpen?: boolean
}

interface Entry { id: string; family: string; title: string; description: string; expected: string[]; forbidden: string[]; healthyTwin: string | null; file: string; events: number; seconds: number; scale: number }
interface Skipped { id: string; family: string; title: string; reason: string }
interface Index { schemaVersion: number; entries: Entry[]; skipped: Skipped[] }
interface Shown { entry: Entry; capture: Capture; text: string; findings: Finding[]; check: LabCheck; notEvaluated: number }

const base = (): string => (import.meta.env.BASE_URL ?? '/').replace(/\/?$/, '/')
const FAMILY_NAMES: Record<string, string> = {
    H01: 'Healthy streams', H02: 'Healthy streams', H03: 'Healthy streams', H04: 'Healthy streams',
}
const familyOf = (e: { family: string }) => FAMILY_NAMES[e.family] ?? e.family

/** The built-in faulty streams, each with its healthy twin: what the Doctor says about a known fault, one click away, with no server. */
export default function FailureLab({ theme, onSaved, defaultOpen = false }: Props) {
    const dark = theme === 'dark'
    const muted = dark ? 'text-slate-300' : 'text-slate-700'
    const strong = dark ? 'text-white' : 'text-slate-900'
    const button = `px-3 py-1.5 rounded-lg text-sm font-medium disabled:opacity-50 ${dark ? 'bg-slate-700 text-slate-100 hover:bg-slate-600' : 'bg-slate-200 text-slate-900 hover:bg-slate-300'}`

    const [index, setIndex] = useState<Index | null>(null)
    const [error, setError] = useState('')
    const [loading, setLoading] = useState(false)
    const [shown, setShown] = useState<Shown | null>(null)
    const [notice, setNotice] = useState('')
    const starting = useRef(false)

    const open = useCallback(async () => {
        if (index || loading || starting.current) return
        starting.current = true
        setLoading(true)
        try {
            const res = await fetch(`${base()}lab/index.json`)
            if (!res.ok) throw new Error(`The lab could not be loaded (HTTP ${res.status}).`)
            setIndex((await res.json()) as Index)
        } catch (err) { setError(err instanceof Error ? err.message : String(err)) } finally { setLoading(false); starting.current = false }
    }, [index, loading])
    // Opened from the start: the browser's own toggle event for an initially open <details> is not relied on to fire.
    useEffect(() => { if (defaultOpen) void open() }, []) // eslint-disable-line react-hooks/exhaustive-deps

    const run = async (entry: Entry) => {
        setError(''); setNotice('')
        try {
            const res = await fetch(`${base()}lab/${entry.file}`)
            if (!res.ok) throw new Error(`${entry.id} could not be loaded (HTTP ${res.status}).`)
            const text = await res.text()
            const { capture } = parseCapture(text)
            const analysis = analyze(capture.records as EngineInput[], { endT: captureEndT(capture), ...(capture.header.profile ? { profile: capture.header.profile } : {}) })
            const open = analysis.findings.filter((f) => f.status === 'open')
            setShown({ entry, capture, text, findings: open, check: checkExpectations(open.map((f) => f.key), entry.expected, entry.forbidden), notEvaluated: analysis.coverage.filter((c) => c.status === 'not-evaluated').length })
        } catch (err) { setError(err instanceof Error ? err.message : String(err)) }
    }

    const save = async () => {
        if (!shown) return
        setError('')
        try {
            await saveCapture({ name: `Lab: ${shown.entry.id}`, text: shown.text, records: shown.capture.records.length, origin: 'file' })
            setNotice(`Saved "Lab: ${shown.entry.id}" to your captures, so it can be compared with another.`)
            onSaved()
        } catch (err) { setError(err instanceof Error ? err.message : String(err)) }
    }

    const records = useMemo(() => new Map((shown?.capture.records ?? []).map((r) => [r.seq, r as Observation])), [shown])
    const families = useMemo(() => {
        const groups = new Map<string, Entry[]>()
        for (const e of index?.entries ?? []) groups.set(familyOf(e), [...(groups.get(familyOf(e)) ?? []), e])
        return [...groups.entries()]
    }, [index])

    return (
        <details open={defaultOpen || undefined} onToggle={(e) => { if ((e.target as HTMLDetailsElement).open) void open() }} data-testid="failure-lab" className={`rounded-lg border px-3 py-2 ${dark ? 'border-slate-700' : 'border-slate-200'}`}>
            <summary className={`cursor-pointer text-sm font-semibold flex items-center gap-2 ${strong}`}><FlaskConical className="w-4 h-4" aria-hidden="true" /> Failure lab</summary>
            <div className="mt-3 space-y-4">
                <p className={`text-sm ${muted}`}>
                    The built-in test streams, each a known fault with a healthy twin, recorded once and read here by the Doctor with the app's own thresholds. Pick one to see
                    what the Doctor says about a fault it was built to find, and whether it found what the stream's author said it should. Nothing here connects to a server.
                    Some were recorded at a quarter of real speed, so their timings are not real-time.
                </p>
                {loading && <p role="status" className={`text-sm ${muted}`}>Loading the lab…</p>}
                {error && <p role="alert" className={`text-sm ${dark ? 'text-red-300' : 'text-red-800'}`} data-testid="lab-error">{error}</p>}

                {families.map(([family, entries]) => (
                    <section key={family} aria-label={family} className="space-y-1">
                        <h3 className={`text-sm font-semibold ${strong}`}>{family}</h3>
                        <ul className="space-y-1">
                            {entries.map((e) => (
                                <li key={e.id} className="flex flex-wrap items-baseline gap-x-3 gap-y-1 text-sm" data-testid="lab-entry" data-id={e.id}>
                                    <button type="button" className={button} onClick={() => void run(e)} aria-label={`Run the Doctor on ${e.id}`}>Run the Doctor</button>
                                    <span className={`font-mono font-medium ${strong}`}>{e.id}</span>
                                    <span className={strong}>{e.title}</span>
                                    <span className={`text-xs ${muted}`}>{e.description}</span>
                                </li>
                            ))}
                        </ul>
                    </section>
                ))}

                {index && index.skipped.length > 0 && (
                    <details>
                        <summary className={`cursor-pointer text-sm font-medium ${strong}`}>Not in the lab ({index.skipped.length})</summary>
                        <ul className={`mt-2 space-y-1 text-sm ${muted}`} data-testid="lab-skipped">
                            {index.skipped.map((s) => <li key={s.id}><span className="font-mono font-medium">{s.id}</span>: {s.reason}.</li>)}
                        </ul>
                    </details>
                )}

                {shown && (
                    <section aria-label={`The Doctor on ${shown.entry.id}`} className="space-y-3" data-testid="lab-result">
                        <h3 className={`text-sm font-semibold ${strong}`}>{shown.entry.id}: {shown.entry.title}</h3>
                        <p className={`text-sm ${shown.check.ok ? (dark ? 'text-emerald-300' : 'text-emerald-800') : (dark ? 'text-red-300' : 'text-red-800')}`} data-testid="lab-verdict">
                            {shown.check.ok ? 'The Doctor found what this stream was built to show, and nothing it should not.' : `The Doctor did not match this stream's expectations: ${shown.check.problems.join('; ')}.`}
                        </p>
                        <ul className="space-y-1 text-sm" aria-label="What was expected" data-testid="lab-expectations">
                            {shown.check.expected.map((x) => (
                                <li key={`e-${x.key}`} className={`flex items-center gap-2 ${strong}`}>
                                    {x.met ? <Check className="w-4 h-4 text-emerald-600" aria-hidden="true" /> : <X className="w-4 h-4 text-red-600" aria-hidden="true" />}
                                    <span>Expected <code>{x.key}</code>: {x.met ? 'found' : 'not found'}</span>
                                </li>
                            ))}
                            {shown.check.forbidden.map((x) => (
                                <li key={`f-${x.key}`} className={`flex items-center gap-2 ${strong}`}>
                                    {x.met ? <Check className="w-4 h-4 text-emerald-600" aria-hidden="true" /> : <X className="w-4 h-4 text-red-600" aria-hidden="true" />}
                                    <span>{x.key === '*' ? 'No finding at all' : <>Not expected: <code>{x.key}</code></>}: {x.met ? 'none appeared' : `appeared (${x.offenders.join(', ')})`}</span>
                                </li>
                            ))}
                        </ul>
                        {shown.findings.length === 0 ? (
                            <p className={`text-sm ${strong}`}>No findings. {shown.notEvaluated > 0 ? `${shown.notEvaluated} check${shown.notEvaluated === 1 ? ' was' : 's were'} not evaluated, so this is not proof it is healthy.` : ''}</p>
                        ) : (
                            <ul className="space-y-2" aria-label="Findings">
                                {shown.findings.map((f, i) => <FindingCard key={f.key} theme={theme} streamId="" finding={f} sectionHeading="h4" defaultOpen={i === 0} lookup={(seq) => records.get(seq)} />)}
                            </ul>
                        )}
                        <div className="flex flex-wrap items-center gap-2">
                            <button type="button" className={button} onClick={() => void save()} data-testid="lab-save">Save to my captures</button>
                            {shown.entry.healthyTwin && index?.entries.find((x) => x.id === shown.entry.healthyTwin) && (
                                <button type="button" className={button} onClick={() => void run(index.entries.find((x) => x.id === shown.entry.healthyTwin)!)} data-testid="lab-twin">Show its healthy twin ({shown.entry.healthyTwin})</button>
                            )}
                        </div>
                        <p role="status" className={`text-sm ${strong}`} data-testid="lab-notice">{notice}</p>
                    </section>
                )}
            </div>
        </details>
    )
}
