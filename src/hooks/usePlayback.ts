import { useState, useRef, useEffect, useCallback } from 'react'
import type { EventMessage } from '../types'

interface UsePlaybackReturn {
    isPaused: boolean
    isReplaying: boolean
    currentEventIndex: number // Index in the events array (0 is newest)
    togglePause: () => void
    seekTo: (index: number) => void // Seek to specific index
    stepForward: () => void
    stepBackward: () => void
    goLive: () => void // Reset to live (index 0, unpaused)
    displayedEvents: EventMessage[] // Events to show based on current state
}

export const usePlayback = (
    allEvents: EventMessage[] // The full history from useEventStream
): UsePlaybackReturn => {
    const [isPaused, setIsPaused] = useState(false)
    const [currentEventIndex, setCurrentEventIndex] = useState(0) // 0 means "live" / newest
    const [isReplaying, setIsReplaying] = useState(false) // True if we are auto-advancing history
    const prevEventsLengthRef = useRef(allEvents.length)
    const replayTimerRef = useRef<number | null>(null)

    // Index Locking Logic:
    // If we are paused or tracking history (index > 0), and new events arrive 
    // at the front of the array (unshifted), we must increment our index 
    // so the view "stays" on the same physical events.
    useEffect(() => {
        const lengthDiff = allEvents.length - prevEventsLengthRef.current

        if (lengthDiff > 0 && (isPaused || currentEventIndex > 0)) {
            setCurrentEventIndex(prev => prev + lengthDiff)
        }

        prevEventsLengthRef.current = allEvents.length
    }, [allEvents.length, isPaused, currentEventIndex])

    // Ensure index is valid when events update (e.g. on clear)
    useEffect(() => {
        if (allEvents.length === 0) {
            setCurrentEventIndex(0)
            return
        }
        if (currentEventIndex >= allEvents.length) {
            setCurrentEventIndex(allEvents.length - 1)
        }
    }, [allEvents.length, currentEventIndex])

    const togglePause = useCallback(() => {
        setIsPaused(prev => {
            const willBePlaying = prev === true
            // If we are resuming (playing) and we were in the past, jump to live
            if (willBePlaying && currentEventIndex > 0) {
                setCurrentEventIndex(0)
            }
            return !prev
        })
        if (isReplaying) {
            stopReplay()
        }
    }, [isReplaying, currentEventIndex])

    const stopReplay = () => {
        setIsReplaying(false)
        if (replayTimerRef.current) {
            clearInterval(replayTimerRef.current)
            replayTimerRef.current = null
        }
    }

    const seekTo = useCallback((index: number) => {
        let newIndex = Math.max(0, Math.min(index, allEvents.length - 1))
        setCurrentEventIndex(newIndex)
        setIsPaused(true) // Seerking implies pausing live updates
        stopReplay()
    }, [allEvents.length])

    const stepForward = useCallback(() => {
        // "Forward" in time means DECREASING the index (0 is newest)
        if (currentEventIndex > 0) {
            setCurrentEventIndex(prev => prev - 1)
        }
    }, [currentEventIndex])

    const stepBackward = useCallback(() => {
        // "Backward" in time means INCREASING the index
        if (currentEventIndex < allEvents.length - 1) {
            setCurrentEventIndex(prev => prev + 1)
        }
    }, [currentEventIndex, allEvents.length])

    const goLive = useCallback(() => {
        setCurrentEventIndex(0)
        setIsPaused(false)
        stopReplay()
    }, [])

    const displayedEvents = allEvents.slice(currentEventIndex)

    return {
        isPaused,
        isReplaying,
        currentEventIndex,
        togglePause,
        seekTo,
        stepForward,
        stepBackward,
        goLive,
        displayedEvents
    }
}
