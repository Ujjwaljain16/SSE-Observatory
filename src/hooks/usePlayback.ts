import { useState, useRef, useEffect, useCallback } from 'react'
import type { EventMessage } from '../types'

interface UsePlaybackReturn {
    isPaused: boolean
    isReplaying: boolean
    playbackSpeed: number
    currentEventIndex: number // Index in the events array (0 is newest)
    togglePause: () => void
    setPlaybackSpeed: (speed: number) => void
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
    const [playbackSpeed, setPlaybackSpeed] = useState(1)
    const [currentEventIndex, setCurrentEventIndex] = useState(0) // 0 means "live" / newest
    const [isReplaying, setIsReplaying] = useState(false) // True if we are auto-advancing history

    const replayTimerRef = useRef<number | null>(null)

    // Ensure index is valid when events update
    useEffect(() => {
        if (currentEventIndex >= allEvents.length && allEvents.length > 0) {
            setCurrentEventIndex(allEvents.length - 1)
        }
    }, [allEvents.length, currentEventIndex])

    const togglePause = useCallback(() => {
        setIsPaused(prev => !prev)
        if (isReplaying) {
            stopReplay()
        }
    }, [isReplaying])

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

    // TODO: Implement actual auto-replay loop if requested later.
    // For now, "Replay" might just mean navigating history.
    // But if we want "Press Play to watch history unfold":
    /*
    const startReplay = useCallback(() => {
        setIsReplaying(true)
        setIsPaused(true)
        replayTimerRef.current = window.setInterval(() => {
            setCurrentEventIndex(prev => {
                if (prev <= 0) {
                    stopReplay()
                    return 0
                }
                return prev - 1
            })
        }, 1000 / playbackSpeed) 
    }, [playbackSpeed])
    */

    // Determine what events to display
    // If live (index 0, not paused), show all events.
    // If paused/seeked, show events from index downwards (older events)
    // Actually, usually we want to see the state AT that point in time.
    // So if I'm at index 5 (5th newest event), I probably want to see events[5...end]
    // But typically user wants to see "what happened up to this point".
    // So displayedEvents should be events.slice(currentEventIndex)

    // Wait, if I'm at index 10 (10 events ago), I want to see the list AS IT WAS then.
    // So I effectively hide events[0...9].
    const displayedEvents = allEvents.slice(currentEventIndex)

    return {
        isPaused,
        isReplaying,
        playbackSpeed,
        currentEventIndex,
        togglePause,
        setPlaybackSpeed,
        seekTo,
        stepForward,
        stepBackward,
        goLive,
        displayedEvents
    }
}
