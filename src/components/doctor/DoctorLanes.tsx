import { useMemo } from 'react'
import type { Theme } from '../../types'
import type { StreamInstance } from '../../hooks/useMultiStream'
import { SEVERITY_RANK } from '../../core/diagnostics/finding'
import { useDoctorViews } from '../../doctor/useDoctor'
import DoctorPanel from './DoctorPanel'
import ProfileEditor from './ProfileEditor'

interface Props {
    theme: Theme
    streams: StreamInstance[]
}

/** One Doctor card per lane, the lane with the worst open finding first. */
export default function DoctorLanes({ theme, streams }: Props) {
    const dark = theme === 'dark'
    const views = useDoctorViews()
    const ordered = useMemo(() => {
        const rank = (id: string) => { const w = views.get(id)?.worst; return w ? SEVERITY_RANK[w] : -1 }
        return [...streams].sort((a, b) => rank(b.id) - rank(a.id))
    }, [streams, views])

    if (streams.length === 0) return null
    return (
        <section aria-label="Stream Doctor for each lane" className="space-y-4 mb-6" data-testid="doctor-lanes">
            <details className={`p-4 rounded-xl border ${dark ? 'bg-slate-900/70 border-slate-700' : 'bg-white border-slate-200'}`}>
                <summary className={`cursor-pointer text-sm font-medium ${dark ? 'text-slate-100' : 'text-slate-900'}`}>Profile for every stream</summary>
                <div className="mt-3"><ProfileEditor theme={theme} /></div>
            </details>
            {ordered.map((s) => (
                <div key={s.id} className={`p-4 rounded-xl border border-l-4 ${dark ? 'bg-slate-900/70 border-slate-700' : 'bg-white border-slate-200'}`} style={{ borderLeftColor: s.color }}>
                    <DoctorPanel theme={theme} streamId={s.id} title={`Doctor: ${s.name}`} heading="h3" />
                </div>
            ))}
        </section>
    )
}
