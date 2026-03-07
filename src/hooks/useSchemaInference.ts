import { useState, useEffect } from 'react'
import type { EventMessage } from '../types'

export interface FieldSchema {
    type: Set<string>
    count: number
    frequency: number // 0 to 1
}

export interface SchemaMap {
    [key: string]: FieldSchema
}

// Helper to get type
const getType = (value: any): string => {
    if (value === null) return 'null'
    if (Array.isArray(value)) return 'array'
    return typeof value
}

// Flatten JSON to dot-notation paths
const flattenObject = (obj: any, prefix = '', result: Record<string, string> = {}) => {
    if (obj === null || typeof obj !== 'object' || Array.isArray(obj)) {
        result[prefix] = getType(obj)
        return result
    }
    for (const key in obj) {
        if (Object.prototype.hasOwnProperty.call(obj, key)) {
            const newKey = prefix ? `${prefix}.${key}` : key
            flattenObject(obj[key], newKey, result)
        }
    }
    return result
}

export const useSchemaInference = (events: EventMessage[]) => {
    const [schema, setSchema] = useState<SchemaMap>({})
    const [isAnalyzing, setIsAnalyzing] = useState(false)

    useEffect(() => {
        setIsAnalyzing(true)

        const timer = setTimeout(() => {
            const newSchema: Record<string, { type: Set<string>, count: number, frequency: number }> = {}
            let validJsonCount = 0

            events.forEach(event => {
                try {
                    const parsed = JSON.parse(event.data)
                    if (parsed && typeof parsed === 'object') {
                        validJsonCount++
                        const flattened = flattenObject(parsed)

                        for (const [key, type] of Object.entries(flattened)) {
                            if (!newSchema[key]) {
                                newSchema[key] = { type: new Set(), count: 0, frequency: 0 }
                            }
                            newSchema[key].type.add(type)
                            newSchema[key].count++
                        }
                    }
                } catch {
                    // Not valid JSON, ignore
                }
            })

            if (validJsonCount > 0) {
                for (const key in newSchema) {
                    newSchema[key].frequency = newSchema[key].count / validJsonCount
                }
            }

            setSchema(newSchema)
            setIsAnalyzing(false)
        }, 500) // 500ms debounce to avoid UI blocking on rapid streams

        return () => clearTimeout(timer)
    }, [events])

    return { schema, isAnalyzing }
}
