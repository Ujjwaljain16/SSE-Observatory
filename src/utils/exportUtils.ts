import type { EventMessage } from '../types'

export interface ExportOptions {
    format: 'json' | 'csv'
    filename?: string
}

export const exportEvents = (events: EventMessage[], options: ExportOptions): void => {
    const { format, filename } = options
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-')
    const defaultFilename = `sse-events-${timestamp}`

    let content: string
    let mimeType: string
    let extension: string

    if (format === 'json') {
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
        const rows = events.map(event => [
            event.id,
            event.timestamp,
            event.type,
            event.parsedType || '',
            `"${event.data.replace(/"/g, '""')}"`
        ])
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

export const getEventStats = (events: EventMessage[]) => {
    const typeCount: Record<string, number> = {}

    events.forEach(event => {
        const type = event.parsedType || event.type
        typeCount[type] = (typeCount[type] || 0) + 1
    })

    const sortedTypes = Object.entries(typeCount)
        .sort((a, b) => b[1] - a[1])
        .slice(0, 10)

    return {
        total: events.length,
        uniqueTypes: Object.keys(typeCount).length,
        topTypes: sortedTypes
    }
}
