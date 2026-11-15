import { afterEach, describe, expect, it, vi } from 'vitest'
import { getProfile, setProfile, subscribeProfile } from '../profileStore'
import { DoctorStore } from '../doctorStore'
import { ObservationRegistry } from '../observationRegistry'
import { capture } from '../../core/testing/captureBuilder'
import { analyze } from '../../core/diagnostics/engine'
import type { StreamProfile } from '../../core/diagnostics/thresholds'

afterEach(() => { setProfile(undefined); localStorage.clear() })

const declared: StreamProfile = { sequence: { field: '$.seq', policy: 'consecutive' }, delivery: 'at_least_once' }

describe('the saved profile', () => {
    it('starts empty and keeps what was saved, as the same object until it changes', () => {
        expect(getProfile()).toBeUndefined()
        setProfile(declared)
        expect(getProfile()).toEqual(declared)
        expect(getProfile()).toBe(getProfile())
    })

    it('an empty profile is the same as none, and clearing removes it', () => {
        setProfile({})
        expect(getProfile()).toBeUndefined()
        setProfile(declared)
        setProfile(undefined)
        expect(localStorage.getItem('sse.doctor.profile')).toBeNull()
    })

    it('ignores stored text that is not a valid profile instead of passing it on', () => {
        localStorage.setItem('sse.doctor.profile', '{"sequence":{"field":"$.seq"}}') // no policy
        expect(getProfile()).toBeUndefined()
        localStorage.setItem('sse.doctor.profile', 'not json')
        expect(getProfile()).toBeUndefined()
        localStorage.setItem('sse.doctor.profile', '{"bogus":1}')
        expect(getProfile()).toBeUndefined()
    })

    it('tells subscribers when it changes', () => {
        const seen = vi.fn()
        const off = subscribeProfile(seen)
        setProfile(declared)
        setProfile(undefined)
        off()
        setProfile(declared)
        expect(seen).toHaveBeenCalledTimes(2)
    })
})

describe('the Doctor with a profile', () => {
    function setup(profile: { current: StreamProfile | undefined }) {
        const registry = new ObservationRegistry()
        const clock = { ms: 0 }
        const listeners = new Set<() => void>()
        const store = new DoctorStore({
            registry, now: () => clock.ms, isHidden: () => false,
            profile: { get: () => profile.current, subscribe: (l) => { listeners.add(l); return () => listeners.delete(l) } },
        })
        const stop = store.subscribe(() => {})
        return { registry, store, stop, advance: (ms: number) => { clock.ms += ms }, change: (p: StreamProfile | undefined) => { profile.current = p; listeners.forEach((l) => l()) } }
    }

    // events carry numbers 1,2,3 then 6: a gap that only a declared sequence may call a problem
    const numbered = () => {
        const b = capture().connect().response()
        for (const [i, n] of [1, 2, 3, 6, 7].entries()) {
            b.silence(100).chunk(30).event('tick', '', 10)
            const rec = b.build().at(-1) as { extracted?: unknown }
            rec.extracted = { seq: n }
            void i
        }
        return b.observations()
    }

    it('judges numbers only once a sequence is declared, and from the records it already holds', async () => {
        const profile: { current: StreamProfile | undefined } = { current: undefined }
        const h = setup(profile)
        h.registry.receive('main', { captureId: 'c', batch: numbered() })
        await h.store.refresh()
        expect(h.store.getViews().get('main')!.profile).toBeUndefined()
        expect(h.store.getViews().get('main')!.findings.some((f) => f.key.startsWith('seq.'))).toBe(false)

        h.advance(5000) // past the reorder window, so the gap is final
        h.change({ sequence: { field: '$.seq', policy: 'consecutive' } })
        await h.store.refresh()
        await h.store.refresh()
        const view = h.store.getViews().get('main')!
        expect(view.profile?.sequence?.field).toBe('$.seq')
        expect(view.findings.some((f) => f.key === 'seq.integrity:gap')).toBe(true)
        h.stop()
    })

    // Campaign C2: declaring, clearing and declaring again re-judges the same records each time. At every step the Doctor shows what a fresh
    // analysis of those records under that profile shows, with one finding per key, never a leftover from the profile before.
    it('re-judges the same records at every change of profile: what a fresh analysis gives, one finding per key, nothing left over', async () => {
        const profile: { current: StreamProfile | undefined } = { current: undefined }
        const h = setup(profile)
        const records = numbered()
        h.registry.receive('main', { captureId: 'c', batch: records })
        await h.store.refresh()
        h.advance(5000)

        const sequenceKeys = (): string[] => h.store.getViews().get('main')!.findings.map((f) => f.key).filter((k) => k.startsWith('seq.')).sort()
        const fresh = (p: StreamProfile | undefined): string[] => analyze(records as never, { ...(p ? { profile: p } : {}), endT: 5000 }).findings.map((f) => f.key).filter((k) => k.startsWith('seq.')).sort()
        const consecutive: StreamProfile = { sequence: { field: '$.seq', policy: 'consecutive' } }
        const monotonic: StreamProfile = { sequence: { field: '$.seq', policy: 'monotonic' } }

        for (const next of [consecutive, undefined, monotonic, consecutive, consecutive, undefined]) {
            h.change(next)
            await h.store.refresh()
            await h.store.refresh()
            const keys = h.store.getViews().get('main')!.findings.map((f) => f.key)
            expect(new Set(keys).size, 'one finding per key').toBe(keys.length)
            expect(sequenceKeys(), `after switching to ${next ? next.sequence?.policy : 'no profile'}`).toEqual(fresh(next))
        }
        h.stop()
    })
})
