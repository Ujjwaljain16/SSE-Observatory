import { useMemo } from 'react'
import type { Theme } from '../../types'
import type { DoctorView } from '../../doctor/doctorSession'
import { observationRegistry } from '../../doctor/observationRegistry'
import { SLOW_WAIT_MS, buildFlow, flowStatements } from '../../doctor/flow'
import { fmtDuration } from './format'

interface Props {
    theme: Theme
    streamId: string
    view: DoctorView
}

const LEFT = 78
const WIDTH = 820
const RIGHT = 10

/** The newest events as they arrived, how long the page took to process them, and when the connection was made again. */
export default function FlowView({ theme, streamId, view }: Props) {
    const dark = theme === 'dark'
    const muted = dark ? 'text-slate-300' : 'text-slate-700'
    const strong = dark ? 'text-white' : 'text-slate-900'
    // Rebuilt when the recording or the page's reports change, not on every tick.
    const flow = useMemo(
        () => buildFlow(observationRegistry.get(streamId)?.store.snapshot() ?? [], view.flowBatches),
        [streamId, view.health.capture.records, view.flowBatches.length], // eslint-disable-line react-hooks/exhaustive-deps -- the records count and the batch count say when they changed
    )
    const sentences = useMemo(() => flowStatements(flow), [flow])

    if (flow.events.length === 0) {
        return <p className={`text-sm ${muted}`} data-testid="doctor-flow">No events have arrived yet. Each one appears here as a tick once the stream sends them.</p>
    }

    const { fromT, toT } = flow.span
    const span = Math.max(toT - fromT, 1)
    const x = (t: number) => LEFT + (Math.max(0, Math.min(t - fromT, span)) / span) * (WIDTH - LEFT - RIGHT)
    const maxQueue = Math.max(1, ...flow.batches.map((b) => b.queueDepth))
    const tick = dark ? 'stroke-white' : 'stroke-slate-900'
    const grid = dark ? 'stroke-slate-600' : 'stroke-slate-300'
    const label = dark ? 'fill-slate-200' : 'fill-slate-800'
    const ok = dark ? 'fill-teal-400' : 'fill-teal-700'
    const slow = dark ? 'fill-amber-300 stroke-amber-100' : 'fill-amber-600 stroke-amber-900'
    const line = dark ? 'stroke-sky-300' : 'stroke-sky-700'
    const slowest = [...flow.batches].sort((a, b) => b.lagMs - a.lagMs).slice(0, 5)

    return (
        <section aria-label="Event flow" className="space-y-3" data-testid="doctor-flow">
            <p className={`text-sm ${muted}`}>
                The newest {flow.events.length.toLocaleString()} events, in the recording's own clock. Each tick is an event arriving from the network.
                Each bar is the page processing some of them, from when the oldest of them arrived until it was handled; a bar that is not teal waited longer than {SLOW_WAIT_MS} ms.
            </p>

            <div className="overflow-x-auto">
                <svg role="img" aria-label={`Flow of ${flow.events.length} events over ${fmtDuration(span)}: ${flow.batches.length} processing batches, ${flow.batches.filter((b) => b.lagMs > SLOW_WAIT_MS).length} slower than ${SLOW_WAIT_MS} milliseconds`} viewBox={`0 0 ${WIDTH} 128`} className="w-full min-w-[640px]" style={{ maxHeight: 240 }}>
                    {[0, 0.25, 0.5, 0.75, 1].map((f) => (
                        <g key={f}>
                            <line x1={x(fromT + span * f)} x2={x(fromT + span * f)} y1={14} y2={118} className={grid} strokeWidth="1" strokeDasharray="2 4" />
                            <text x={x(fromT + span * f)} y={10} textAnchor={f === 1 ? 'end' : f === 0 ? 'start' : 'middle'} className={label} fontSize="10">{fmtDuration(fromT + span * f)}</text>
                        </g>
                    ))}
                    <text x={4} y={34} className={label} fontSize="11">Arrived</text>
                    <text x={4} y={70} className={label} fontSize="11">Page</text>
                    <text x={4} y={104} className={label} fontSize="11">Queued</text>

                    {flow.reconnects.map((t, i) => (
                        <g key={i}>
                            <line x1={x(t)} x2={x(t)} y1={14} y2={118} className={dark ? 'stroke-red-300' : 'stroke-red-700'} strokeWidth="1.5" strokeDasharray="5 3" />
                            <text x={x(t) + 3} y={124} className={label} fontSize="10">reconnected</text>
                        </g>
                    ))}
                    {flow.events.map((e) => <line key={e.seq} x1={x(e.t)} x2={x(e.t)} y1={22} y2={38} className={tick} strokeWidth="1" opacity="0.8" />)}
                    {flow.batches.map((b, i) => (
                        <rect
                            key={i}
                            x={x(b.receivedT)}
                            y={58}
                            width={Math.max(2, x(b.processedT) - x(b.receivedT))}
                            height={14}
                            rx={2}
                            className={b.lagMs > SLOW_WAIT_MS ? slow : ok}
                            strokeWidth={b.lagMs > SLOW_WAIT_MS ? 1.5 : 0}
                            opacity="0.85"
                        >
                            <title>{`${b.n} event${b.n === 1 ? '' : 's'}, waited ${fmtDuration(b.lagMs)}, ${b.queueDepth} still queued`}</title>
                        </rect>
                    ))}
                    {flow.batches.length > 1 && (
                        <polyline
                            fill="none"
                            strokeWidth="1.5"
                            className={line}
                            points={flow.batches.map((b) => `${x(b.processedT).toFixed(1)},${(112 - (b.queueDepth / maxQueue) * 22).toFixed(1)}`).join(' ')}
                        />
                    )}
                </svg>
            </div>

            <section aria-label="Where the time went" className="space-y-1" data-testid="flow-summary">
                <h3 className={`text-sm font-semibold ${strong}`}>Where the time went</h3>
                <ul className={`list-disc pl-5 text-sm space-y-1 ${strong}`}>
                    {sentences.map((s, i) => <li key={i} className={s.startsWith('Not measured') ? muted : undefined}>{s}</li>)}
                </ul>
            </section>

            {slowest.length > 0 && (
                <table className="w-full text-sm" data-testid="flow-slowest">
                    <caption className={`text-left font-semibold mb-1 ${strong}`}>The slowest batches</caption>
                    <thead>
                        <tr className={`text-left ${muted}`}>{['Handled at', 'Events in the batch', 'The oldest waited', 'Still queued'].map((h) => <th key={h} scope="col" className="py-1 pr-3">{h}</th>)}</tr>
                    </thead>
                    <tbody className={strong}>
                        {slowest.map((b, i) => (
                            <tr key={i} className={`border-t ${dark ? 'border-slate-700' : 'border-slate-200'}`}>
                                <td className="py-1 pr-3 tabular-nums">{fmtDuration(b.processedT)}</td>
                                <td className="py-1 pr-3 tabular-nums">{b.n.toLocaleString()}</td>
                                <td className="py-1 pr-3 tabular-nums">{fmtDuration(b.lagMs)}</td>
                                <td className="py-1 tabular-nums">{b.queueDepth.toLocaleString()}</td>
                            </tr>
                        ))}
                    </tbody>
                </table>
            )}
        </section>
    )
}
