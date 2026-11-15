import { useCallback, useSyncExternalStore } from 'react'
import { doctorStore } from './doctorStore'
import type { DoctorView } from './doctorSession'
import { SEVERITY_RANK } from '../core/diagnostics/finding'
import { MAIN_STREAM } from './observationRegistry'

/** The full view of one stream (changes about once a second while the stream is live). */
export function useDoctorView(streamId: string = MAIN_STREAM): DoctorView | undefined {
    const get = useCallback(() => doctorStore.getViews().get(streamId), [streamId])
    return useSyncExternalStore(doctorStore.subscribe, get, () => undefined)
}

/** Every stream's view, for the lane list. */
export function useDoctorViews(): ReturnType<typeof doctorStore.getViews> {
    return useSyncExternalStore(doctorStore.subscribe, doctorStore.getViews, () => doctorStore.getViews())
}

/** Stream ids never contain this. */
const SEP = String.fromCharCode(1)

export interface DoctorSummary {
    /** Open findings of error or critical severity. */
    errors: number
    warnings: number
    infos: number
    worst: DoctorView['worst']
}

/**
 * A short summary for badges, for one stream or the sum over several lanes. The snapshot is a string, so a component using
 * it re-renders only when the numbers change, not on the once-a-second refresh of the view.
 */
export function useDoctorSummary(streams: string | readonly string[] = MAIN_STREAM): DoctorSummary {
    const ids = typeof streams === 'string' ? [streams] : streams
    const idKey = ids.join(SEP)
    const get = useCallback(() => {
        const views = doctorStore.getViews()
        let errors = 0, warnings = 0, infos = 0
        let worst: DoctorView['worst'] = null
        for (const id of idKey.split(SEP)) {
            const v = views.get(id)
            if (!v) continue
            errors += v.open.error + v.open.critical
            warnings += v.open.warning
            infos += v.open.info
            if (v.worst && (worst === null || SEVERITY_RANK[v.worst] > SEVERITY_RANK[worst])) worst = v.worst
        }
        return `${worst ?? ''}|${errors}|${warnings}|${infos}`
    }, [idKey])
    const key = useSyncExternalStore(doctorStore.subscribe, get, () => '|0|0|0')
    const [worst, errors, warnings, infos] = key.split('|')
    return { worst: (worst || null) as DoctorSummary['worst'], errors: Number(errors), warnings: Number(warnings), infos: Number(infos) }
}
