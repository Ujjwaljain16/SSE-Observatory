import { useState, useRef, useCallback, useMemo } from 'react'
import type { EventMessage } from '../types'

interface UsePlaybackReturn {
    isPaused: boolean
    currentEventIndex: number // Index in the events array (0 is newest)
    togglePause: () => void
    seekTo: (index: number) => void // Seek to specific index
    stepForward: () => void
    stepBackward: () => void
    goLive: () => void // Reset to live (index 0, unpaused)
    displayedEvents: EventMessage[] // Events to show based on current state
}

// "Paused before any event existed": everything that arrives afterwards is hidden.
const EMPTY = '\u0000empty'

/**
 * Time travel over the newest-first ring buffer.
 *
 * The playhead is anchored to an event *id*, not an index. New events pushed at the front, and
 * old events evicted from the back, therefore never move the view: the index is derived from where the
 * anchored event currently sits. (An index-based playhead drifts once the buffer is full, because the
 * buffer length stops changing while its contents keep sliding.)
 */
export const usePlayback = (allEvents: EventMessage[]): UsePlaybackReturn => {
    // undefined = live. Anything else = paused on that event.
    const [anchor, setAnchor] = useState<string | undefined>(undefined)
    const eventsRef = useRef(allEvents)
    eventsRef.current = allEvents

    const currentEventIndex = useMemo(() => {
        if (anchor === undefined) return 0
        if (anchor === EMPTY) return allEvents.length
        const i = allEvents.findIndex((e) => e.id === anchor)
        if (i !== -1) return i
        // The anchored event was evicted (or the stream restarted): stay at the oldest event we still have.
        return allEvents.length > 0 ? allEvents.length - 1 : 0
    }, [anchor, allEvents])
    const indexRef = useRef(currentEventIndex)
    indexRef.current = currentEventIndex

    const anchorAt = useCallback((index: number) => {
        const list = eventsRef.current
        if (list.length === 0) { setAnchor(EMPTY); return }
        setAnchor(list[Math.max(0, Math.min(index, list.length - 1))].id)
    }, [])

    const togglePause = useCallback(() => {
        setAnchor((prev) => {
            if (prev !== undefined) return undefined // resume → jump to live
            const head = eventsRef.current[0]
            return head ? head.id : EMPTY
        })
    }, [])

    const seekTo = useCallback((index: number) => anchorAt(index), [anchorAt])

    const stepForward = useCallback(() => {
        // "Forward" in time means DECREASING the index (0 is newest)
        if (indexRef.current > 0) anchorAt(indexRef.current - 1)
    }, [anchorAt])

    const stepBackward = useCallback(() => {
        // "Backward" in time means INCREASING the index
        if (indexRef.current < eventsRef.current.length - 1) anchorAt(indexRef.current + 1)
    }, [anchorAt])

    const goLive = useCallback(() => setAnchor(undefined), [])

    const displayedEvents = useMemo(
        () => (currentEventIndex === 0 ? allEvents : allEvents.slice(currentEventIndex)),
        [allEvents, currentEventIndex]
    )

    return {
        isPaused: anchor !== undefined,
        currentEventIndex,
        togglePause,
        seekTo,
        stepForward,
        stepBackward,
        goLive,
        displayedEvents,
    }
}
