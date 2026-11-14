import { SEVERITY_RANK, type Severity } from '../core/diagnostics/finding'
import { serializeCapture } from '../core/capture/format'
import { addBookmark, listBookmarks, saveCapture } from './captureLibrary'
import { captureOf } from './captureOf'
import type { DoctorView } from './doctorSession'
import { flightRecorderEnabled, pushFlightNotice } from './flightSetting'
import { getProfile } from './profileStore'

/**
 * The flight recorder: with the person's say-so, the app keeps a copy of the recording on its own at the moments that matter, so what led up to
 * a problem is not lost when the bounded recording moves on or the tab is closed. A copy is kept when the Doctor first reports an error, and
 * when the person adds a bookmark. It is an ordinary saved capture (in this browser only, not redacted), named "Flight recorder: ...", so it is
 * listed, opened, compared, exported and deleted like any other, and the retention setting covers it.
 *
 * It never fills the library on its own: a few copies per recording and per visit, one at a time with a pause between, and a full library
 * stops it (it says so) instead of deleting anything.
 */

export type KeepResult = { ok: true; name: string; truncated: boolean } | { ok: false; reason: string }

/** Saves the recording of a stream, as it is now, in the library. */
export async function keepCopy(streamId: string, view: Pick<DoctorView, 'nowT' | 'captureId'>, name: string): Promise<KeepResult> {
    const snapshot = captureOf(streamId, view.nowT, getProfile())
    if (!snapshot) return { ok: false, reason: 'nothing had been recorded yet' }
    try {
        const meta = await saveCapture({ name, text: serializeCapture(snapshot.capture), records: snapshot.capture.records.length, origin: 'recording' })
        // bookmarks made while looking at this recording go with the copy
        for (const m of await listBookmarks(view.captureId ?? streamId)) await addBookmark({ captureId: meta.id, label: m.label, t: m.t })
        return { ok: true, name: meta.name, truncated: snapshot.truncated }
    } catch (err) {
        return { ok: false, reason: err instanceof Error ? err.message : String(err) }
    }
}

export interface FlightNotice {
    /** When it was said (epoch milliseconds). */
    at: number
    ok: boolean
    text: string
}

export interface FlightOptions {
    keep?: (streamId: string, view: Pick<DoctorView, 'nowT' | 'captureId'>, name: string) => Promise<KeepResult>
    notify?: (notice: FlightNotice) => void
    /** The least serious finding that makes a copy (default: error). */
    minSeverity?: Severity
    maxPerRecording?: number
    maxPerSession?: number
    /** The pause between two copies. */
    cooldownMs?: number
    now?: () => number
}

interface Recording { captureId: string | null; reported: Set<string>; kept: number }

export const FLIGHT_PREFIX = 'Flight recorder: '

export class FlightRecorder {
    private readonly keep: NonNullable<FlightOptions['keep']>
    private readonly notify: (n: FlightNotice) => void
    private readonly min: number
    private readonly maxPerRecording: number
    private readonly maxPerSession: number
    private readonly cooldownMs: number
    private readonly now: () => number
    private readonly recordings = new Map<string, Recording>()
    private kept = 0
    private lastAt = -Infinity
    private busy = false

    constructor(options: FlightOptions = {}) {
        this.keep = options.keep ?? keepCopy
        this.notify = options.notify ?? (() => {})
        this.min = SEVERITY_RANK[options.minSeverity ?? 'error']
        this.maxPerRecording = options.maxPerRecording ?? 3
        this.maxPerSession = options.maxPerSession ?? 8
        this.cooldownMs = options.cooldownMs ?? 15_000
        this.now = options.now ?? (() => Date.now())
    }

    /** Looks at the Doctor's views and keeps a copy for a finding that is open and serious and has not been kept for yet. */
    observe(views: ReadonlyMap<string, DoctorView>): void {
        for (const [streamId, view] of views) {
            let rec = this.recordings.get(streamId)
            // a new recording of the same stream starts over: its findings are new, and so is its allowance
            if (!rec || rec.captureId !== view.captureId) { rec = { captureId: view.captureId, reported: new Set(), kept: 0 }; this.recordings.set(streamId, rec) }
            const fresh = view.findings.filter((f) => f.status === 'open' && SEVERITY_RANK[f.severity] >= this.min && !rec!.reported.has(f.key))
            if (fresh.length === 0) continue
            // each finding is dealt with once per recording, whether or not a copy could be kept: a refused one must not be retried every second
            for (const f of fresh) rec.reported.add(f.key)
            const worst = [...fresh].sort((a, b) => SEVERITY_RANK[b.severity] - SEVERITY_RANK[a.severity])[0]!
            const name = `${FLIGHT_PREFIX}${worst.title}${fresh.length > 1 ? ` (and ${fresh.length - 1} more)` : ''}`
            this.attempt(streamId, view, name, rec)
        }
    }

    /** A bookmark was added: keep a copy of the recording at that moment, under the same limits. */
    mark(streamId: string, view: Pick<DoctorView, 'nowT' | 'captureId'>, label: string): void {
        let rec = this.recordings.get(streamId)
        if (!rec || rec.captureId !== view.captureId) { rec = { captureId: view.captureId, reported: new Set(), kept: 0 }; this.recordings.set(streamId, rec) }
        this.attempt(streamId, view, `${FLIGHT_PREFIX}${label}`, rec)
    }

    private attempt(streamId: string, view: Pick<DoctorView, 'nowT' | 'captureId'>, name: string, rec: Recording): void {
        const refuse = (why: string) => this.notify({ at: this.now(), ok: false, text: `No copy was kept for "${name.slice(FLIGHT_PREFIX.length)}": ${why}.` })
        if (rec.kept >= this.maxPerRecording) return refuse(`it is the ${this.maxPerRecording + 1}th this recording would have made, and the limit is ${this.maxPerRecording}`)
        if (this.kept >= this.maxPerSession) return refuse(`${this.maxPerSession} copies were already kept this visit`)
        if (this.busy || this.now() - this.lastAt < this.cooldownMs) return refuse('another copy was kept a moment ago')
        this.busy = true
        this.lastAt = this.now()
        rec.kept++
        this.kept++
        void this.keep(streamId, view, name).then((result) => {
            if (result.ok) this.notify({ at: this.now(), ok: true, text: `Kept a copy of the recording: "${result.name}". It is in Captures, in this browser only and not redacted.${result.truncated ? ' The recording had folded older detail away, so it is not the whole stream.' : ''}` })
            else {
                rec.kept--; this.kept-- // nothing was kept, so nothing is counted
                this.notify({ at: this.now(), ok: false, text: `Could not keep a copy for "${name.slice(FLIGHT_PREFIX.length)}": ${result.reason}` })
            }
        }, (err: unknown) => {
            rec.kept--; this.kept--
            this.notify({ at: this.now(), ok: false, text: `Could not keep a copy: ${err instanceof Error ? err.message : String(err)}` })
        }).finally(() => { this.busy = false })
    }
}

/** The one recorder the app uses: the hook feeds it findings, and the bookmark button asks it for a copy. */
export const flight = new FlightRecorder({ notify: pushFlightNotice })

/** For the bookmark button: keeps a copy of the recording at that moment, only when the person switched the flight recorder on. */
export function keepOnMark(streamId: string, view: Pick<DoctorView, 'nowT' | 'captureId'>, label: string): void {
    if (flightRecorderEnabled()) flight.mark(streamId, view, label)
}
