export interface EventMessage {
    id: string
    timestamp: string
    type: string
    data: string
    raw: string
    parsedType?: string | undefined
    streamId?: string | undefined
    streamColor?: string | undefined
    arrivalTime?: number | undefined
    _searchIndex?: string | undefined
}

export interface Profile {
    name: string
    url: string
    token: string
}

export type FilterMode = 'simple' | 'regex' | 'query'

export interface QueryFilter {
    query: string
    compiled: ((event: EventMessage) => boolean) | null
    error: string | null
}

export interface CustomFilter {
    field: string
    activeValues: Set<string>
    isRegex?: boolean
    regexPattern?: string
}

export type Theme = 'dark' | 'light'
