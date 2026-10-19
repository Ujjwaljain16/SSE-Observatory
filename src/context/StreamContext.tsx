import { createContext, useContext } from 'react'
import type { EventMessage, CustomFilter, Profile } from '../types'
import type { Interceptor } from '../hooks/useInterceptors'
import type { StreamInstance } from '../hooks/useMultiStream'
import type { TraceEntry } from '../hooks/useCorrelationTracker'
import type { PatternRule, PatternAlert } from '../hooks/usePatternDetector'

interface StreamContextValue {
    connected: boolean
    isLoading: boolean
    /** Stream is down and retrying with backoff. */
    reconnecting: boolean
    /** Messages dropped because the page could not keep up with the stream. */
    droppedCount: number
    connectionError: string
    connectionTime: number
    connect: (url: string, token?: string) => void
    disconnect: () => void
    useProxy: boolean
    setUseProxy: (v: boolean) => void

    allEvents: EventMessage[]
    filteredEvents: EventMessage[]
    clearEvents: () => void
    copiedId: string | null
    copyToClipboard: (text: string, eventId: string) => void

    isPaused: boolean
    currentEventIndex: number
    togglePause: () => void
    seekTo: (index: number) => void
    stepForward: () => void
    stepBackward: () => void
    goLive: () => void

    searchQuery: string
    setSearchQuery: (q: string) => void
    query: string
    setQuery: (q: string) => void
    queryError: string | null
    customFilters: CustomFilter[]
    newFilterField: string
    setNewFilterField: (f: string) => void
    addCustomFilter: () => string | null
    removeCustomFilter: (field: string) => void
    toggleFilterValue: (field: string, value: string) => void
    clearFilterValues: (field: string) => void
    getUniqueValuesForField: (field: string) => string[]
    toggleRegexMode: (field: string) => void
    setRegexPattern: (field: string, pattern: string) => void

    interceptors: Interceptor[]
    addInterceptor: (name?: string) => void
    removeInterceptor: (id: string) => void
    renameInterceptor: (id: string, newName: string) => void
    updateInterceptorCode: (id: string, code: string) => void
    toggleInterceptor: (id: string) => void
    reorderInterceptors: (from: number, to: number) => void
    lastEventPreview: { raw: string; transformed: string | undefined } | undefined

    idbAvailable: boolean
    totalStoredCount: number
    loadBefore: (cursor?: number | null) => Promise<EventMessage[]>
    clearStorage: () => Promise<void>
    replayFromStorage: () => Promise<EventMessage[]>

    streams: StreamInstance[]
    mergedEvents: EventMessage[]
    addStream: (name: string, url: string) => string
    removeStream: (id: string) => void
    connectStream: (id: string) => void
    disconnectStream: (id: string) => void
    clearStreamEvents: (id: string) => void

    profiles: Profile[]
    activeProfileTab: string | null
    setActiveProfileTab: (name: string | null) => void
    saveProfile: () => void
    loadProfile: (profile: Profile) => void
    deleteProfile: (name: string) => void

    mockFileName: string | null
    isMockUploading: boolean
    isMockRunning: boolean
    mockSpeed: number
    isMockLooping: boolean
    mockTotalEvents: number
    mockUploadError: string | null
    mockStreamUrl: string | null
    handleMockUpload: (event: React.ChangeEvent<HTMLInputElement>) => void
    toggleMockServer: () => Promise<string | null>
    setMockSpeed: (speed: number) => void
    setIsMockLooping: (val: boolean) => void

    // perf metrics moved to PerfContext to prevent high-frequency re-renders

    traces: Map<string, TraceEntry>
    activeTraceId: string | null
    setActiveTraceId: (id: string | null) => void
    getEventChain: (traceId: string) => EventMessage[]
    getTraceForEvent: (event: EventMessage) => TraceEntry | null
    correlationField: string
    traceCount: number
    clearTraces: () => void

    patternRules: PatternRule[]
    patternAlerts: PatternAlert[]
    activePatternAlerts: PatternAlert[]
    addPatternRule: (rule: Omit<PatternRule, 'id'>) => void
    removePatternRule: (id: string) => void
    togglePatternRule: (id: string) => void
    dismissPatternAlert: (id: string) => void
    clearPatternAlerts: () => void
}

export const StreamContext = createContext<StreamContextValue | null>(null)

export const useStreamContext = (): StreamContextValue => {
    const ctx = useContext(StreamContext)
    if (!ctx) throw new Error('useStreamContext must be used inside <StreamProvider>')
    return ctx
}
