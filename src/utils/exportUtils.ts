import type { EventMessage } from '../types'
import { createRecording } from './replayUtils'

export interface ExportOptions {
    format: 'json' | 'csv' | 'record'
    filename?: string
}

export const exportEvents = (events: EventMessage[], options: ExportOptions): void => {
    const { format, filename } = options
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-')
    const defaultFilename = `sse-events-${timestamp}`

    let content: string
    let mimeType: string
    let extension: string

    if (format === 'record') {
        const recording = createRecording(events)
        content = JSON.stringify(recording, null, 2)
        mimeType = 'application/json'
        extension = 'sse-record'
    } else if (format === 'json') {
        const exportData = events.map(event => {
            try {
                return {
                    id: event.id,
                    timestamp: event.timestamp,
                    type: event.type,
                    parsedType: event.parsedType || null,
                    data: JSON.parse(event.data)
                }
            } catch {
                return {
                    id: event.id,
                    timestamp: event.timestamp,
                    type: event.type,
                    parsedType: event.parsedType || null,
                    data: event.data
                }
            }
        })
        content = JSON.stringify(exportData, null, 2)
        mimeType = 'application/json'
        extension = 'json'
    } else {
        // CSV format
        const headers = ['ID', 'Timestamp', 'Type', 'Parsed Type', 'Data']
        const rows = events.map(event => [event.id, event.timestamp, event.type, event.parsedType || '', event.data].map(csvCell))
        content = [headers.join(','), ...rows.map(row => row.join(','))].join('\n')
        mimeType = 'text/csv'
        extension = 'csv'
    }

    const blob = new Blob([content], { type: mimeType })
    const url = URL.createObjectURL(blob)
    const link = document.createElement('a')
    link.href = url
    link.download = `${filename || defaultFilename}.${extension}`
    document.body.appendChild(link)
    link.click()
    document.body.removeChild(link)
    URL.revokeObjectURL(url)
}

/**
 * One CSV cell. Always quoted, so a comma, quote or line break in an event name or id cannot shift the columns, and a cell that begins
 * with = + - @ (or a tab or carriage return) gets a leading apostrophe, so a spreadsheet shows it as text instead of running it as a formula.
 */
export const csvCell = (value: string): string => {
    const text = /^[=+\-@\t\r]/.test(value) ? `'${value}` : value
    return `"${text.replace(/"/g, '""')}"`
}

export const getEventStats = (events: EventMessage[]) => {
    // a Map: an event named __proto__ or constructor is an ordinary key, not a property of the object
    const typeCount = new Map<string, number>()

    events.forEach(event => {
        const type = event.parsedType || event.type
        typeCount.set(type, (typeCount.get(type) ?? 0) + 1)
    })

    const sortedTypes = [...typeCount.entries()]
        .sort((a, b) => b[1] - a[1])
        .slice(0, 10)

    return {
        total: events.length,
        uniqueTypes: typeCount.size,
        topTypes: sortedTypes
    }
}
