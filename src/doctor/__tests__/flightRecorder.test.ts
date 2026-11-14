import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { FLIGHT_PREFIX, FlightRecorder, keepCopy, keepOnMark, flight, type KeepResult, type FlightNotice } from '../flightRecorder'
import { clearFlightNotices, flightRecorderEnabled, getFlightNotices, setFlightRecorderEnabled, subscribeFlightSetting } from '../flightSetting'
import { addBookmark, listBookmarks, listCaptures, resetLibrary } from '../captureLibrary'
import { observationRegistry } from '../observationRegistry'
import { healthyStart } from '../../core/testing/captureBuilder'
import type { Finding, Severity } from '../../core/diagnostics/finding'
import type { DoctorView } from '../doctorSession'

async function wipe() {
    resetLibrary()
    await new Promise<void>((resolve) => {
        const req = indexedDB.deleteDatabase('sse-doctor-db')
        req.onsuccess = () => resolve()
        req.onerror = () => resolve()
        req.onblocked = () => resolve()
    })
    resetLibrary()
}

const finding = (key: string, severity: Severity, status: Finding['status'] = 'open'): Finding => ({
    key, ruleId: key.split(':')[0]!, ruleVersion: 1, severity, title: `Title of ${key}`, summary: 's', facts: [], deductions: [], limits: [], status, firstSeenT: 0, lastSeenT: 0, occurrences: 1,
})
const view = (captureId: string | null, findings: Finding[]): DoctorView => ({ captureId, nowT: 5000, findings } as unknown as DoctorView)
const views = (...entries: Array<[string, DoctorView]>) => new Map(entries)

/** A recorder with a fake clock and a keep function that records what it was asked. */
function setup(options: ConstructorParameters<typeof FlightRecorder>[0] = {}, result: KeepResult | (() => Promise<KeepResult>) = { ok: true, name: 'kept', truncated: false }) {
    const clock = { ms: 1_000_000 }
    const asked: string[] = []
    const notices: FlightNotice[] = []
    const recorder = new FlightRecorder({
        keep: async (_id, _view, name) => { asked.push(name); return typeof result === 'function' ? result() : { ...result, ...(result.ok ? { name } : {}) } as KeepResult },
        notify: (n) => notices.push(n),
        now: () => clock.ms,
        ...options,
    })
    const settle = () => new Promise((r) => setTimeout(r, 0))
    return { recorder, asked, notices, clock, settle }
}

describe('FlightRecorder: when a finding opens', () => {
    it('keeps one copy, named for the finding, when an error is first reported', async () => {
        const { recorder, asked, notices, settle } = setup()
        recorder.observe(views(['main', view('c1', [finding('proto.content-type', 'error')])]))
        await settle()
        expect(asked).toEqual([`${FLIGHT_PREFIX}Title of proto.content-type`])
        expect(notices[0]).toMatchObject({ ok: true })
        expect(notices[0]!.text).toContain('in this browser only and not redacted')
    })

    it('ignores warnings and notes, and findings that are already resolved', async () => {
        const { recorder, asked, settle } = setup()
        recorder.observe(views(['main', view('c1', [finding('a', 'warning'), finding('b', 'info'), finding('c', 'error', 'resolved')])]))
        await settle()
        expect(asked).toEqual([])
    })

    it('can be set to a lower bar', async () => {
        const { recorder, asked, settle } = setup({ minSeverity: 'warning' })
        recorder.observe(views(['main', view('c1', [finding('a', 'warning')])]))
        await settle()
        expect(asked).toHaveLength(1)
    })

    it('does not keep another copy for the same finding while it stays open, however often it is looked at', async () => {
        const { recorder, asked, clock, settle } = setup()
        const v = views(['main', view('c1', [finding('x', 'error')])])
        for (let i = 0; i < 5; i++) { recorder.observe(v); clock.ms += 60_000; await settle() }
        expect(asked).toHaveLength(1)
    })

    it('names one copy for several findings that open together, after the worst', async () => {
        const { recorder, asked, settle } = setup()
        recorder.observe(views(['main', view('c1', [finding('a', 'error'), finding('b', 'critical'), finding('c', 'error')])]))
        await settle()
        expect(asked).toEqual([`${FLIGHT_PREFIX}Title of b (and 2 more)`])
    })

    it('starts over with a new recording of the same stream: its findings and its allowance are new', async () => {
        const { recorder, asked, clock, settle } = setup()
        recorder.observe(views(['main', view('c1', [finding('x', 'error')])]))
        await settle(); clock.ms += 60_000
        recorder.observe(views(['main', view('c2', [finding('x', 'error')])]))
        await settle()
        expect(asked).toHaveLength(2)
    })

    it('keeps streams apart: each lane is its own recording', async () => {
        const { recorder, asked, clock, settle } = setup()
        recorder.observe(views(['a', view('c1', [finding('x', 'error')])]))
        await settle(); clock.ms += 60_000
        recorder.observe(views(['b', view('c9', [finding('x', 'error')])]))
        await settle()
        expect(asked).toHaveLength(2)
    })
})

describe('FlightRecorder: the limits, so it never fills the library on its own', () => {
    it('pauses between copies, and says so when a finding came inside the pause', async () => {
        const { recorder, asked, notices, clock, settle } = setup({ cooldownMs: 15_000 })
        recorder.observe(views(['main', view('c1', [finding('a', 'error')])]))
        await settle()
        clock.ms += 2000
        recorder.observe(views(['main', view('c1', [finding('a', 'error'), finding('b', 'error')])]))
        await settle()
        expect(asked).toHaveLength(1)
        expect(notices.at(-1)).toMatchObject({ ok: false })
        expect(notices.at(-1)!.text).toContain('another copy was kept a moment ago')
    })

    it('keeps at most N per recording, and says which finding got none', async () => {
        const { recorder, asked, notices, clock, settle } = setup({ maxPerRecording: 2, cooldownMs: 0 })
        for (const k of ['a', 'b', 'c']) {
            recorder.observe(views(['main', view('c1', [finding(k, 'error')])]))
            await settle(); clock.ms += 1000
        }
        expect(asked).toHaveLength(2)
        expect(notices.at(-1)!.text).toMatch(/Title of c.*the limit is 2/)
    })

    it('keeps at most N per visit, across recordings', async () => {
        const { recorder, asked, notices, clock, settle } = setup({ maxPerSession: 2, cooldownMs: 0 })
        for (const c of ['c1', 'c2', 'c3']) {
            recorder.observe(views(['main', view(c, [finding('x', 'error')])]))
            await settle(); clock.ms += 1000
        }
        expect(asked).toHaveLength(2)
        expect(notices.at(-1)!.text).toContain('2 copies were already kept this visit')
    })

    it('does not count a copy that could not be saved, and says why (a full library, for one)', async () => {
        const { recorder, asked, notices, clock, settle } = setup({ cooldownMs: 0, maxPerRecording: 1 }, { ok: false, reason: 'The library holds 20 captures. Delete one to make room.' })
        recorder.observe(views(['main', view('c1', [finding('a', 'error')])]))
        await settle(); clock.ms += 1000
        recorder.observe(views(['main', view('c1', [finding('b', 'error')])])) // not blocked by the limit: the first one kept nothing
        await settle()
        expect(asked).toHaveLength(2)
        expect(notices[0]).toMatchObject({ ok: false })
        expect(notices[0]!.text).toContain('The library holds 20 captures')
    })

    it('survives a keep function that throws', async () => {
        const { recorder, notices, settle } = setup({}, () => Promise.reject(new Error('boom')))
        recorder.observe(views(['main', view('c1', [finding('a', 'error')])]))
        await settle()
        expect(notices[0]).toMatchObject({ ok: false })
        expect(notices[0]!.text).toContain('boom')
    })
})

describe('FlightRecorder: a bookmark', () => {
    it('keeps a copy named for the bookmark, under the same limits', async () => {
        const { recorder, asked, settle } = setup()
        recorder.mark('main', { nowT: 4000, captureId: 'c1' }, 'the stall starts here')
        await settle()
        expect(asked).toEqual([`${FLIGHT_PREFIX}the stall starts here`])
    })

    it('is held back by the pause like any other copy', async () => {
        const { recorder, asked, notices, settle } = setup()
        recorder.mark('main', { nowT: 4000, captureId: 'c1' }, 'one')
        await settle()
        recorder.mark('main', { nowT: 4100, captureId: 'c1' }, 'two')
        await settle()
        expect(asked).toHaveLength(1)
        expect(notices.at(-1)!.text).toContain('a moment ago')
    })
})

describe('keepCopy: a real copy in the library', () => {
    beforeEach(async () => { await wipe(); observationRegistry.reset('flight-test') })
    afterEach(async () => { await wipe() })

    const record = () => {
        const b = healthyStart().repeat(6, 200, (x, i) => x.frame('tick', String(i + 1)))
        observationRegistry.receive('flight-test', { captureId: 'cap-1', batch: b.observations() })
    }

    it('saves the recording as it is, named as asked, with the bookmarks made while looking at it', async () => {
        record()
        await addBookmark({ captureId: 'cap-1', label: 'before the stall', t: 300 })
        const result = await keepCopy('flight-test', { nowT: 5000, captureId: 'cap-1' }, `${FLIGHT_PREFIX}Test finding`)
        expect(result).toMatchObject({ ok: true, name: 'Flight recorder: Test finding' })
        const [saved] = await listCaptures()
        expect(saved).toMatchObject({ name: 'Flight recorder: Test finding', origin: 'recording' })
        expect((await listBookmarks(saved!.id)).map((m) => m.label)).toEqual(['before the stall'])
    })

    it('says so, and saves nothing, when nothing has been recorded', async () => {
        expect(await keepCopy('nothing-here', { nowT: 0, captureId: null }, 'x')).toEqual({ ok: false, reason: 'nothing had been recorded yet' })
        expect(await listCaptures()).toEqual([])
    })

    it('stops at a full library with its words, and deletes nothing to make room', async () => {
        record()
        for (let i = 0; i < 20; i++) await keepCopy('flight-test', { nowT: 5000, captureId: 'cap-1' }, `copy ${i}`)
        const full = await keepCopy('flight-test', { nowT: 5000, captureId: 'cap-1' }, 'one too many')
        expect(full).toMatchObject({ ok: false })
        expect((full as { reason: string }).reason).toContain('Delete one to make room')
        expect(await listCaptures()).toHaveLength(20)
    })
})

describe('the switch and the notices', () => {
    beforeEach(() => { localStorage.clear(); setFlightRecorderEnabled(false); clearFlightNotices() })

    it('is off until the person turns it on, and tells subscribers', () => {
        expect(flightRecorderEnabled()).toBe(false)
        const seen = vi.fn()
        const stop = subscribeFlightSetting(seen)
        setFlightRecorderEnabled(true)
        expect(flightRecorderEnabled()).toBe(true)
        expect(seen).toHaveBeenCalledTimes(1)
        window.dispatchEvent(new StorageEvent('storage', { key: 'sse.flight.keep' }))
        expect(seen).toHaveBeenCalledTimes(2)
        stop()
        setFlightRecorderEnabled(false)
        expect(seen).toHaveBeenCalledTimes(2)
    })

    it('keepOnMark does nothing while it is off', async () => {
        const spy = vi.spyOn(flight, 'mark').mockImplementation(() => {})
        keepOnMark('main', { nowT: 1, captureId: 'c' }, 'x')
        expect(spy).not.toHaveBeenCalled()
        setFlightRecorderEnabled(true)
        keepOnMark('main', { nowT: 1, captureId: 'c' }, 'x')
        expect(spy).toHaveBeenCalledWith('main', { nowT: 1, captureId: 'c' }, 'x')
        spy.mockRestore()
    })

    it('keeps only the last few notices', async () => {
        const { pushFlightNotice } = await import('../flightSetting')
        for (let i = 0; i < 8; i++) pushFlightNotice({ at: i, ok: true, text: `n${i}` })
        expect(getFlightNotices().map((n) => n.text)).toEqual(['n3', 'n4', 'n5', 'n6', 'n7'])
        clearFlightNotices()
        expect(getFlightNotices()).toEqual([])
    })
})
