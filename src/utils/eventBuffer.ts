import type { EventMessage } from '../types'

/**
 * The UI keeps events newest-first in a capped ring buffer, so the buffer's *length* stops
 * changing once it is full. New events must therefore be detected by identity, not by length.
 *
 * Returns the events that arrived after `lastId` in chronological order (oldest → newest),
 * which is the order consumers append them in. If `lastId` is null or no longer in the buffer
 * (cleared, or evicted because more than a whole buffer arrived) every event is new.
 */
export function newEventsSince(eventsNewestFirst: EventMessage[], lastId: string | null): EventMessage[] {
    if (eventsNewestFirst.length === 0) return []
    let end = eventsNewestFirst.length
    if (lastId !== null) {
        const idx = eventsNewestFirst.findIndex((e) => e.id === lastId)
        if (idx !== -1) end = idx
    }
    const fresh = new Array<EventMessage>(end)
    for (let i = 0; i < end; i++) fresh[end - 1 - i] = eventsNewestFirst[i]
    return fresh
}
