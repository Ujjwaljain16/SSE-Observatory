import { useMemo, useState } from 'react'
import type { Theme } from '../../types'
import type { DoctorView } from '../../doctor/doctorSession'
import { observationRegistry } from '../../doctor/observationRegistry'
import { readSequence, trustOf, type CellState } from '../../doctor/sequenceView'
import { fmtDuration } from './format'

interface Props {
    theme: Theme
    streamId: string
    view: DoctorView
    /** Goes to the Profile tab, where a sequence is declared; absent where the profile is edited elsewhere. */
    onDeclare?: () => void
}

const LABEL: Record<CellState, string> = { ok: 'in order', gap: 'after a gap', duplicate: 'seen before', backward: 'lower than before' }
const CELL: Record<CellState, { dark: string; light: string }> = {
    ok: { dark: 'bg-emerald-600', light: 'bg-emerald-600' },
    gap: { dark: 'bg-red-500', light: 'bg-red-600' },
    duplicate: { dark: 'bg-amber-400', light: 'bg-amber-500' },
    backward: { dark: 'bg-fuchsia-400', light: 'bg-fuchsia-600' },
}

export default function SequenceView({ theme, streamId, view, onDeclare }: Props) {
    const dark = theme === 'dark'
    const [showAll, setShowAll] = useState(false)
    const muted = dark ? 'text-slate-300' : 'text-slate-700'
    const strong = dark ? 'text-white' : 'text-slate-900'
    const contract = view.profile?.sequence

    // Read from the recording when the view changes (about once a second), not on every record.
    const { reading, ids } = useMemo(() => {
        const records = observationRegistry.get(streamId)?.store.snapshot() ?? []
        const eventIds = records.filter((r) => r.kind === 'event').map((r) => (r as { sseId: string }).sseId).filter((id) => id !== '')
        return { reading: contract ? readSequence(records, contract.policy) : undefined, ids: eventIds.slice(-200) }
    }, [streamId, view.health.capture.records, contract]) // eslint-disable-line react-hooks/exhaustive-deps -- the record count says when the recording changed

    const trust = trustOf(contract !== undefined, ids)
    const anomalies = reading?.cells.filter((c) => c.state !== 'ok') ?? []
    const counts = { ok: 0, gap: 0, duplicate: 0, backward: 0 } as Record<CellState, number>
    for (const c of reading?.cells ?? []) counts[c.state]++

    return (
        <section aria-label="Sequence" className="space-y-4" data-testid="doctor-sequence">
            <div>
                <p className={`text-sm font-semibold ${strong}`} data-testid="sequence-trust">
                    {trust === 'declared' && `Declared: the stream's own numbers are ${contract?.useSseId ? 'its SSE ids' : `read from ${contract?.field}`}, counted ${contract?.policy === 'consecutive' ? 'one by one (a skipped number is a loss)' : 'upwards (jumps are fine, repeats and going backwards are not)'}.`}
                    {trust === 'inferred' && 'Not declared: the ids happen to count up by one. That is a hint, not a check.'}
                    {trust === 'none' && 'Not declared: continuity cannot be verified, because the ids prove nothing on their own.'}
                </p>
                {trust !== 'declared' && (
                    <p className={`text-sm ${muted}`}>
                        A server may legitimately send 104 and then 111, so numbers are only judged once you say which ones count.{' '}
                        {onDeclare
                            ? <button type="button" onClick={onDeclare} className={`underline ${dark ? 'text-teal-300' : 'text-teal-800'}`}>Declare the sequence</button>
                            : 'Declare the sequence in the profile above the lanes.'}
                    </p>
                )}
            </div>

            {contract && reading && (
                <>
                    <p className={`text-sm ${muted}`}>
                        {reading.cells.length.toLocaleString()} numbered event{reading.cells.length === 1 ? '' : 's'} read (the latest {Math.min(400, reading.cells.length)} are shown):{' '}
                        {counts.ok} in order, {counts.gap} after a gap, {counts.duplicate} seen before, {counts.backward} lower than before.
                        {reading.unreadable > 0 && ` ${reading.unreadable.toLocaleString()} event${reading.unreadable === 1 ? ' had' : 's had'} no readable number: the numbers are read when an event is recorded, so a stream that was already connected needs to reconnect after the sequence is declared.`}
                    </p>

                    {reading.cells.length > 0 && (
                        <div aria-hidden="true" className="flex flex-wrap gap-0.5" data-testid="sequence-strip">
                            {reading.cells.map((c) => (
                                <span key={c.recordSeq} title={`${c.value} (${LABEL[c.state]})`} className={`inline-block w-2.5 h-4 rounded-sm ${CELL[c.state][dark ? 'dark' : 'light']}`} />
                            ))}
                        </div>
                    )}
                    <p className={`text-xs ${muted}`}>
                        This is the plain order of arrival. The Findings tab gives a late number a short window before calling it lost, and treats events replayed after a reconnect as expected, so the two can differ.
                    </p>

                    {anomalies.length > 0 ? (
                        <table className="w-full text-sm" data-testid="sequence-anomalies">
                            <caption className={`text-left font-semibold mb-1 ${strong}`}>Where the numbers did not follow on</caption>
                            <thead>
                                <tr className={`text-left ${muted}`}>
                                    <th scope="col" className="py-1 pr-3">What</th><th scope="col" className="py-1 pr-3">Number</th><th scope="col" className="py-1 pr-3">Missing</th><th scope="col" className="py-1 pr-3">Record</th><th scope="col" className="py-1">At</th>
                                </tr>
                            </thead>
                            <tbody className={strong}>
                                {anomalies.slice(-50).map((c) => (
                                    <tr key={c.recordSeq} className={`border-t ${dark ? 'border-slate-700' : 'border-slate-200'}`}>
                                        <td className="py-1 pr-3">{LABEL[c.state]}</td>
                                        <td className="py-1 pr-3 tabular-nums">{c.value}{c.partition ? ` (${c.partition})` : ''}</td>
                                        <td className="py-1 pr-3 tabular-nums">{c.missing ? (c.missing.from === c.missing.to ? c.missing.from : `${c.missing.from} to ${c.missing.to}`) : '–'}</td>
                                        <td className="py-1 pr-3 tabular-nums">#{c.recordSeq}</td>
                                        <td className="py-1 tabular-nums">{fmtDuration(c.t)}</td>
                                    </tr>
                                ))}
                            </tbody>
                        </table>
                    ) : reading.cells.length > 0 ? (
                        <p className={`text-sm ${strong}`}>Every number read so far followed on from the one before.</p>
                    ) : null}

                    {reading.cells.length > 0 && (
                        <div>
                            <button type="button" aria-expanded={showAll} onClick={() => setShowAll(!showAll)} className={`text-sm underline ${dark ? 'text-teal-300' : 'text-teal-800'}`}>
                                {showAll ? 'Hide the full list' : `Show all ${reading.cells.length} numbers`}
                            </button>
                            {showAll && (
                                <table className="w-full text-sm mt-2">
                                    <caption className="sr-only">Every number read, in order of arrival</caption>
                                    <thead><tr className={`text-left ${muted}`}><th scope="col" className="pr-3">Number</th><th scope="col" className="pr-3">State</th><th scope="col" className="pr-3">Record</th><th scope="col">At</th></tr></thead>
                                    <tbody className={strong}>
                                        {reading.cells.map((c) => (
                                            <tr key={c.recordSeq} className={`border-t ${dark ? 'border-slate-700' : 'border-slate-200'}`}>
                                                <td className="pr-3 tabular-nums">{c.value}</td><td className="pr-3">{LABEL[c.state]}</td><td className="pr-3 tabular-nums">#{c.recordSeq}</td><td className="tabular-nums">{fmtDuration(c.t)}</td>
                                            </tr>
                                        ))}
                                    </tbody>
                                </table>
                            )}
                        </div>
                    )}
                </>
            )}

            {!contract && ids.length > 0 && (
                <p className={`text-sm ${muted}`}>Recent ids: <code>{ids.slice(-8).join(', ')}</code></p>
            )}
        </section>
    )
}
