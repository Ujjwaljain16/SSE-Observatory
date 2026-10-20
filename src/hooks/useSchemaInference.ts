import { useState, useEffect, useRef } from 'react'
import type { EventMessage } from '../types'
import { getParsedData } from '../utils/eventUtils'

export interface FieldSchema {
    type: Set<string>
    count: number
    frequency: number // 0 to 1
}

export interface SchemaMap {
    [key: string]: FieldSchema
}

/** Inference looks at the newest events only, so cost stays flat however large the buffer is. */
const SAMPLE_SIZE = 300
/** At most one analysis per interval while events keep arriving (throttle, not debounce: a steady stream must still update). */
const THROTTLE_MS = 500

const getType = (value: unknown): string => {
    if (value === null) return 'null'
    if (Array.isArray(value)) return 'array'
    return typeof value
}

const flattenObject = (obj: unknown, prefix = '', result: Record<string, string> = Object.create(null)) => {
    if (obj === null || typeof obj !== 'object' || Array.isArray(obj)) {
        result[prefix] = getType(obj)
        return result
    }
    for (const key of Object.keys(obj)) {
        flattenObject((obj as Record<string, unknown>)[key], prefix ? `${prefix}.${key}` : key, result)
    }
    return result
}

export function inferSchema(events: EventMessage[], sampleSize = SAMPLE_SIZE): SchemaMap {
    const schema: SchemaMap = Object.create(null)
    let validJsonCount = 0

    for (const event of events.slice(0, sampleSize)) {
        const parsed = getParsedData(event) // parsed once per event and shared with the filters
        if (parsed === null || typeof parsed !== 'object') continue
        validJsonCount++
        for (const [key, type] of Object.entries(flattenObject(parsed))) {
            const field = (schema[key] ??= { type: new Set(), count: 0, frequency: 0 })
            field.type.add(type)
            field.count++
        }
    }
    if (validJsonCount > 0) for (const key of Object.keys(schema)) schema[key].frequency = schema[key].count / validJsonCount
    return schema
}

export const useSchemaInference = (events: EventMessage[]) => {
    const [schema, setSchema] = useState<SchemaMap>({})
    const [isAnalyzing, setIsAnalyzing] = useState(false)
    const latest = useRef(events)
    latest.current = events
    const timer = useRef<ReturnType<typeof setTimeout> | null>(null)

    useEffect(() => {
        if (timer.current) return // an analysis is already scheduled; it will read the newest events
        setIsAnalyzing(true)
        timer.current = setTimeout(() => {
            timer.current = null
            setSchema(inferSchema(latest.current))
            setIsAnalyzing(false)
        }, THROTTLE_MS)
    }, [events])

    useEffect(() => () => { if (timer.current) { clearTimeout(timer.current); timer.current = null } }, [])

    return { schema, isAnalyzing }
}
