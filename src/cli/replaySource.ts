import { parseCapture } from '../core/capture/format'
import { hasPayloadText } from '../core/capture/streamText'
import { isRecordedSize, replayCopy, ReplayCopyError } from '../core/capture/replayCopy'
import { sessionFromCapture } from '../../lib/mock/capturePlan.js'

/** Present only when the replay is synthetic: how many event bodies are placeholders, and how many of those had no recorded size. */
export interface SyntheticReplay { events: number; unsized: number }

export interface LoadedReplay {
    session?: ReturnType<typeof sessionFromCapture>['session']
    synthetic?: SyntheticReplay
    error?: string
}

/**
 * The session a command replays (Q-I1). A capture that holds payload (the wire bytes, redacted stream text, or event data) is replayed
 * exactly as it was recorded. A capture without one, such as the one the app exports (it records what happened on the wire, not what the
 * events said), gets a placeholder copy built IN MEMORY by the same function the app's Replay button uses: ids, event names, order and
 * time are the capture's, each body is a placeholder of the recorded size, and the result says it is synthetic. The file is never changed.
 * A capture that cannot be replayed either way is refused with the reason.
 */
export function loadReplaySession(text: string): LoadedReplay {
    const exact = sessionFromCapture(text)
    if (exact.session) return { session: exact.session }
    const refusal = exact.error ?? 'cannot be replayed'

    let parsed: ReturnType<typeof parseCapture>
    try { parsed = parseCapture(text) } catch { return { error: refusal } }
    const { capture } = parsed
    if (hasPayloadText(capture)) return { error: refusal } // it has a payload, so the refusal is about something else (size, connections)

    const events = capture.records.filter((r) => r.kind === 'event')
    if (events.length === 0) return { error: 'This capture holds no payload to replay and no events to build a synthetic replay from: it records network reads and their sizes, not events. Capture again with the Doctor, or import a v1 recording.' }
    if (!events.some((e) => isRecordedSize((e as { dataBytes?: unknown }).dataBytes))) {
        return { error: 'This capture holds no payload to replay and records no event sizes to build a synthetic replay from. Capture again with the Doctor, or import a v1 recording.' }
    }

    let copy: ReturnType<typeof replayCopy>
    try { copy = replayCopy(text) } catch (e) {
        if (e instanceof ReplayCopyError) return { error: `This capture holds no payload to replay, and ${e.message}.` }
        throw e
    }
    const built = sessionFromCapture(copy.text)
    if (!built.session) return { error: built.error ?? refusal }
    return { session: built.session, synthetic: { events: copy.filled, unsized: copy.unsized } }
}

/** What to say, on stderr, when a replay is synthetic. */
export function syntheticNotice(s: SyntheticReplay): string {
    const unsized = s.unsized === 0 ? '' : ` ${s.unsized} ${s.unsized === 1 ? 'event has' : 'events have'} no recorded size and got the smallest valid body.`
    return `note: SYNTHETIC replay, not byte-exact: this capture holds no payload (the app records what happened on the wire, not what events said), so ${s.events} ${s.events === 1 ? 'event body is a placeholder' : 'event bodies are placeholders'} of the recorded size.${unsized} Ids, event names, order and timing are the capture's; comments, heartbeats and chunk boundaries are not replayed. The file is not changed.\n`
}
