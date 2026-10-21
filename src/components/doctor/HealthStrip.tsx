import type { Theme } from '../../types'
import type { HealthView } from '../../doctor/doctorSession'
import { fmtAge, fmtBytes, fmtDuration } from './format'

interface Props {
    theme: Theme
    health: HealthView
}

interface Item { label: string; value: string; note?: string | undefined }

function items(h: HealthView): Item[] {
    const out: Item[] = [
        { label: 'Connection', value: h.phase === 'idle' ? 'not started' : h.phase, note: h.phase === 'idle' ? undefined : `attempt ${h.attempt + 1}${h.phaseAgeMs !== null ? `, for ${fmtDuration(h.phaseAgeMs)}` : ''}` },
        { label: 'Last byte', value: fmtAge(h.lastByteAgeMs) },
        { label: 'Last origin byte', value: fmtAge(h.lastOriginAgeMs), note: h.proxyBeats > 0 ? 'proxy comments do not count' : undefined },
    ]
    if (h.proxyBeats > 0) out.push({ label: 'Last proxy heartbeat', value: fmtAge(h.proxyBeatAgeMs), note: `${h.proxyBeats} seen` })
    out.push(
        { label: 'Last event', value: fmtAge(h.lastEventAgeMs), note: `${h.events.toLocaleString()} event${h.events === 1 ? '' : 's'}` },
        {
            label: 'Origin heartbeat',
            value: h.originBeats === 0 ? 'none seen' : h.originBeatMedianMs !== null ? `every ~${fmtDuration(h.originBeatMedianMs)}` : `${h.originBeats} seen`,
            note: h.originBeats === 0 ? 'no comment lines from the origin' : undefined,
        },
        { label: 'Reconnects', value: String(h.reconnects) },
        {
            label: 'Page processing',
            value: h.consumer ? `p95 ${h.consumer.p95LagMs === null ? '–' : fmtDuration(h.consumer.p95LagMs)}` : 'not measured',
            note: h.consumer ? `queue ${h.consumer.queueDepth}` : 'no events processed yet',
        },
        {
            label: 'Recording',
            value: `${h.capture.records.toLocaleString()} records`,
            note: `${fmtBytes(h.capture.retainedBytes)} of ${fmtBytes(h.capture.capBytes)}${h.capture.dropped > 0 ? `; ${h.capture.dropped.toLocaleString()} detail records folded away` : ''}`,
        },
    )
    return out
}

export function HealthStrip({ theme, health }: Props) {
    const dark = theme === 'dark'
    return (
        <dl aria-label="Stream health" className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-2" data-testid="doctor-health">
            {items(health).map(({ label, value, note }) => (
                <div key={label} className={`rounded-lg px-3 py-2 ${dark ? 'bg-slate-800' : 'bg-slate-100'}`}>
                    <dt className={`text-xs ${dark ? 'text-slate-300' : 'text-slate-700'}`}>{label}</dt>
                    <dd className={`text-sm font-semibold tabular-nums ${dark ? 'text-white' : 'text-slate-900'}`}>{value}</dd>
                    {note && <dd className={`text-xs ${dark ? 'text-slate-300' : 'text-slate-700'}`}>{note}</dd>}
                </div>
            ))}
        </dl>
    )
}
