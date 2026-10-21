import { useMemo, useState, useSyncExternalStore } from 'react'
import { Star } from 'lucide-react'
import type { Theme } from '../../types'
import { useStreamContext } from '../../context/StreamContext'
import { describeProfile, parseProfile, sameProbe } from '../../core/diagnostics/profile'
import type { StreamProfile } from '../../core/diagnostics/thresholds'
import { suggestFields } from '../../doctor/fieldSuggestions'
import { getPins, setPins } from '../../doctor/pins'
import { getProfile, setProfile, subscribeProfile } from '../../doctor/profileStore'

interface Props {
    theme: Theme
}

type Mode = 'none' | 'sse-id' | 'field'

const KIND_LABEL = { counter: 'counts up by one', timestamp: 'looks like a time', number: 'number', other: '' } as const

function formFrom(p: StreamProfile | undefined) {
    const s = p?.sequence
    return {
        mode: (s ? (s.useSseId ? 'sse-id' : 'field') : 'none') as Mode,
        field: s?.field ?? '',
        policy: s?.policy ?? 'consecutive',
        partitionBy: s?.partitionBy ?? '',
        delivery: p?.delivery ?? '',
        timestampField: p?.timestampField ?? '',
        firstEventMs: p?.expected?.firstEventMs?.toString() ?? '',
        maxSilenceMs: p?.expected?.maxSilenceMs?.toString() ?? '',
        heartbeatMs: p?.expected?.heartbeatMs?.toString() ?? '',
    }
}

function profileFrom(f: ReturnType<typeof formFrom>): unknown {
    const expected: Record<string, number> = {}
    for (const [key, text] of [['firstEventMs', f.firstEventMs], ['maxSilenceMs', f.maxSilenceMs], ['heartbeatMs', f.heartbeatMs]] as const) {
        if (text.trim() !== '') expected[key] = Number(text)
    }
    return {
        ...(f.mode !== 'none' ? { sequence: { policy: f.policy, ...(f.mode === 'sse-id' ? { useSseId: true } : { field: f.field.trim() }), ...(f.partitionBy.trim() ? { partitionBy: f.partitionBy.trim() } : {}) } } : {}),
        ...(f.delivery ? { delivery: f.delivery } : {}),
        ...(f.timestampField.trim() ? { timestampField: f.timestampField.trim() } : {}),
        ...(Object.keys(expected).length > 0 ? { expected } : {}),
    }
}

export default function ProfileEditor({ theme }: Props) {
    const dark = theme === 'dark'
    const saved = useSyncExternalStore(subscribeProfile, getProfile, () => undefined)
    const { allEvents, mergedEvents } = useStreamContext()
    const [form, setForm] = useState(() => formFrom(saved))
    const [jsonText, setJsonText] = useState<string | null>(null)
    const [errors, setErrors] = useState<string[]>([])
    const [message, setMessage] = useState('')
    const [pins, setPinsState] = useState(getPins)

    const muted = dark ? 'text-slate-300' : 'text-slate-700'
    const strong = dark ? 'text-white' : 'text-slate-900'
    const field = `rounded-lg border px-2 py-1 text-sm ${dark ? 'bg-slate-800 border-slate-600 text-white placeholder-slate-400' : 'bg-white border-slate-300 text-slate-900 placeholder-slate-500'}`
    const set = <K extends keyof typeof form>(key: K, value: (typeof form)[K]) => { setForm((f) => ({ ...f, [key]: value })); setMessage('') }

    // Fields worth declaring, read from the latest events (newest first in the buffer).
    const suggestions = useMemo(() => {
        const source = allEvents.length > 0 ? allEvents : mergedEvents
        const payloads: unknown[] = []
        for (const e of source.slice(0, 30).reverse()) {
            try { payloads.push(JSON.parse(e.data)) } catch { /* not JSON: nothing to read a field from */ }
        }
        const found = suggestFields(payloads)
        return [...found.filter((f) => pins.includes(f.path)), ...found.filter((f) => !pins.includes(f.path))]
    }, [allEvents, mergedEvents, pins])

    const save = (candidate: unknown) => {
        const checked = parseProfile(candidate)
        if (!checked.ok) { setErrors(checked.errors); setMessage(''); return }
        setErrors([])
        const next = Object.keys(checked.profile).length > 0 ? checked.profile : undefined
        const reconnect = !sameProbe(saved, next)
        setProfile(next)
        setForm(formFrom(next))
        setJsonText(null)
        setMessage(next
            ? `Saved: ${describeProfile(next)}. The rules use it now.${reconnect ? ' The numbers are read from each event as it is recorded, so reconnect for events from now on to carry them.' : ''}`
            : 'The profile is cleared.')
    }

    const togglePin = (path: string) => {
        const next = pins.includes(path) ? pins.filter((p) => p !== path) : [...pins, path]
        setPins(next)
        setPinsState(next)
    }

    return (
        <section aria-label="Profile" className="space-y-5" data-testid="doctor-profile">
            <p className={`text-sm ${muted}`}>
                A profile says what this stream promises, so the checks can tell a problem from a choice: gaps and duplicates are only
                judged once you say which numbers count. It applies to every stream in this browser and is the same JSON the command line reads with <code>--profile</code>.
            </p>

            <form onSubmit={(e) => { e.preventDefault(); save(profileFrom(form)) }} className="space-y-5">
                <fieldset className="space-y-2">
                    <legend className={`text-sm font-semibold ${strong}`}>How the events are numbered</legend>
                    <div className="space-y-1">
                        {([['none', 'Not declared (no gap or duplicate checks)'], ['sse-id', 'The SSE id field'], ['field', 'A field in the event data']] as const).map(([value, label]) => (
                            <label key={value} className={`flex items-center gap-2 text-sm ${strong}`}>
                                <input type="radio" name="sequence-mode" value={value} checked={form.mode === value} onChange={() => set('mode', value)} /> {label}
                            </label>
                        ))}
                    </div>
                    {form.mode === 'field' && (
                        <label className={`block text-sm ${strong}`}>Path to the number
                            <input value={form.field} onChange={(e) => set('field', e.target.value)} placeholder="$.seq" className={`${field} block mt-1 w-full max-w-xs`} data-testid="profile-field" aria-describedby="profile-field-help" />
                            <span id="profile-field-help" className={`block text-xs mt-0.5 ${muted}`}>A JSON path into the event data, such as $.seq or $.data.id.</span>
                        </label>
                    )}
                    {form.mode !== 'none' && (
                        <>
                            <label className={`block text-sm ${strong}`}>Counting
                                <select value={form.policy} onChange={(e) => set('policy', e.target.value as 'consecutive' | 'monotonic')} className={`${field} block mt-1`} data-testid="profile-policy">
                                    <option value="consecutive">Every step is +1 (a skipped number is a loss)</option>
                                    <option value="monotonic">Always upwards (jumps are fine)</option>
                                </select>
                            </label>
                            <label className={`block text-sm ${strong}`}>Separate counts per (optional)
                                <input value={form.partitionBy} onChange={(e) => set('partitionBy', e.target.value)} placeholder="$.shard, or $event" className={`${field} block mt-1 w-full max-w-xs`} />
                            </label>
                        </>
                    )}
                </fieldset>

                <label className={`block text-sm ${strong}`}>Delivery
                    <select value={form.delivery} onChange={(e) => set('delivery', e.target.value)} className={`${field} block mt-1`}>
                        <option value="">Not stated (events may be replayed after a reconnect)</option>
                        <option value="at_least_once">At least once (replay after a reconnect is expected)</option>
                        <option value="exactly_once">Exactly once (a repeat is an error)</option>
                        <option value="at_most_once">At most once (losses are possible by design)</option>
                    </select>
                </label>

                <label className={`block text-sm ${strong}`}>Producer timestamp (optional)
                    <input value={form.timestampField} onChange={(e) => set('timestampField', e.target.value)} placeholder="$.ts" className={`${field} block mt-1 w-full max-w-xs`} data-testid="profile-timestamp" />
                </label>

                <fieldset className="space-y-2">
                    <legend className={`text-sm font-semibold ${strong}`}>What to expect (optional, in milliseconds)</legend>
                    <div className="flex flex-wrap gap-3">
                        {([['firstEventMs', 'Time to the first event'], ['maxSilenceMs', 'Longest silence'], ['heartbeatMs', 'Heartbeat every']] as const).map(([key, label]) => (
                            <label key={key} className={`text-sm ${strong}`}>{label}
                                <input type="number" min="1" value={form[key]} onChange={(e) => set(key, e.target.value)} className={`${field} block mt-1 w-36`} />
                            </label>
                        ))}
                    </div>
                </fieldset>

                <div className="flex flex-wrap gap-2">
                    <button type="submit" data-testid="profile-save" className="px-3 py-1.5 rounded-lg text-sm font-medium bg-teal-700 text-white hover:bg-teal-600">Save profile</button>
                    <button type="button" onClick={() => save({})} className={`px-3 py-1.5 rounded-lg text-sm ${dark ? 'bg-slate-700 text-slate-100 hover:bg-slate-600' : 'bg-slate-200 text-slate-900 hover:bg-slate-300'}`}>Clear</button>
                </div>
            </form>

            {errors.length > 0 && (
                <div role="alert" className={`text-sm rounded-lg p-3 ${dark ? 'bg-red-900/40 text-red-100' : 'bg-red-50 text-red-900'}`} data-testid="profile-errors">
                    <p className="font-semibold">That profile cannot be used:</p>
                    <ul className="list-disc pl-5">{errors.map((e, i) => <li key={i}>{e}</li>)}</ul>
                </div>
            )}
            <p role="status" className={`text-sm ${strong}`} data-testid="profile-message">{message}</p>

            <section aria-label="Fields in recent events" className="space-y-2">
                <h3 className={`text-sm font-semibold ${strong}`}>Fields in recent events</h3>
                {suggestions.length === 0 ? (
                    <p className={`text-sm ${muted}`}>Connect to a stream that sends JSON and its numeric fields are listed here, so a sequence or a timestamp can be picked instead of typed.</p>
                ) : (
                    <ul className="space-y-1" data-testid="profile-suggestions">
                        {suggestions.map((s) => (
                            <li key={s.path} className={`flex flex-wrap items-center gap-2 text-sm ${strong}`}>
                                <button
                                    type="button"
                                    aria-pressed={pins.includes(s.path)}
                                    aria-label={`${pins.includes(s.path) ? 'Unpin' : 'Pin'} ${s.path}`}
                                    onClick={() => togglePin(s.path)}
                                    className={`p-1 rounded ${dark ? 'hover:bg-slate-700' : 'hover:bg-slate-100'}`}
                                >
                                    <Star className={`w-4 h-4 ${pins.includes(s.path) ? (dark ? 'fill-amber-300 text-amber-300' : 'fill-amber-500 text-amber-700') : muted}`} aria-hidden="true" />
                                </button>
                                <code className="font-semibold">{s.path}</code>
                                <span className={muted}>e.g. {s.sample}{KIND_LABEL[s.kind] ? ` · ${KIND_LABEL[s.kind]}` : ''}</span>
                                <button type="button" onClick={() => setForm((f) => ({ ...f, mode: 'field', field: s.path })) } className={`px-2 py-0.5 rounded text-xs ${dark ? 'bg-slate-700 text-slate-100 hover:bg-slate-600' : 'bg-slate-200 text-slate-900 hover:bg-slate-300'}`} data-testid={`use-seq-${s.path}`}>Use as sequence</button>
                                {s.kind !== 'counter' && (
                                    <button type="button" onClick={() => setForm((f) => ({ ...f, timestampField: s.path }))} className={`px-2 py-0.5 rounded text-xs ${dark ? 'bg-slate-700 text-slate-100 hover:bg-slate-600' : 'bg-slate-200 text-slate-900 hover:bg-slate-300'}`}>Use as timestamp</button>
                                )}
                            </li>
                        ))}
                    </ul>
                )}
                <p className={`text-xs ${muted}`}>Picking a field fills the form above; nothing changes until you save.</p>
            </section>

            <details onToggle={(e) => { if ((e.target as HTMLDetailsElement).open && jsonText === null) setJsonText(JSON.stringify(profileFrom(form), null, 2)) }}>
                <summary className={`cursor-pointer text-sm font-medium ${strong}`}>Edit as JSON (the file the command line reads)</summary>
                <div className="mt-2 space-y-2">
                    <label className={`block text-sm ${strong}`}>
                        <span className="sr-only">Profile JSON</span>
                        <textarea value={jsonText ?? ''} onChange={(e) => setJsonText(e.target.value)} rows={8} spellCheck={false} className={`${field} w-full font-mono`} data-testid="profile-json" />
                    </label>
                    <button type="button" className={`px-3 py-1.5 rounded-lg text-sm ${dark ? 'bg-slate-700 text-slate-100 hover:bg-slate-600' : 'bg-slate-200 text-slate-900 hover:bg-slate-300'}`} onClick={() => {
                        try { save(JSON.parse(jsonText ?? '')) } catch { setErrors(['That is not valid JSON.']) }
                    }}>Apply JSON</button>
                </div>
            </details>
        </section>
    )
}
