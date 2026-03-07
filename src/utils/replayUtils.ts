import type { EventMessage } from '../types'

export interface SSERecordEvent extends EventMessage {
    deltaMs: number // Milliseconds since the previous event
}

export interface SSERecording {
    version: '1.0'
    createdAt: string
    totalEvents: number
    durationMs: number
    events: SSERecordEvent[]
}

export const createRecording = (events: EventMessage[]): SSERecording => {
    // Events in our system are stored newest-first. We need oldest-first for playback.
    const chronologicalEvents = [...events].reverse()

    if (chronologicalEvents.length === 0) {
        return {
            version: '1.0',
            createdAt: new Date().toISOString(),
            totalEvents: 0,
            durationMs: 0,
            events: []
        }
    }

    let totalDurationMs = 0
    let previousMs = chronologicalEvents[0].arrivalTime ?? 0

    const recordEvents: SSERecordEvent[] = chronologicalEvents.map((event, index) => {
        if (index === 0) {
            return { ...event, deltaMs: 0 }
        }

        const currentMs = event.arrivalTime ?? previousMs
        const delta = Math.max(0, currentMs - previousMs)
        previousMs = currentMs
        totalDurationMs += delta

        return { ...event, deltaMs: delta }
    })

    return {
        version: '1.0',
        createdAt: new Date().toISOString(),
        totalEvents: recordEvents.length,
        durationMs: totalDurationMs,
        events: recordEvents
    }
}
