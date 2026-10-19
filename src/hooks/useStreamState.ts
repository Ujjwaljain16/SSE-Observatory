/**
 * useStreamState.ts
 *
 * Extracts all hook orchestration from AppProviders into a single testable hook.
 * Returns two shaped objects:
 *   streamValue — everything that goes into StreamContext (low-frequency updates)
 *   perfValue   — high-frequency metrics that go into PerfContext
 *
 * AppProviders becomes ~50 lines: it calls this hook and wraps the results
 * in context providers. This decouples the orchestration logic from React's
 * provider tree, making both individually testable and maintainable.
 */

import { useState, useMemo, useEffect, useCallback, useRef } from 'react'

import { useProfiles } from './useProfiles'
import { useCustomFilters } from './useCustomFilters'
import { useQueryParser } from './useQueryParser'
import { useEventSearch } from './useEventSearch'
import { useSharedStream } from './useSharedStream'
import { useFilterWorker } from './useFilterWorker'
import { usePlayback } from './usePlayback'
import { useInterceptors } from './useInterceptors'
import { useEventStorage } from './useEventStorage'
import { useMultiStream } from './useMultiStream'
import { useMockServer } from './useMockServer'
import { useCorrelationTracker } from './useCorrelationTracker'
import { usePatternDetector } from './usePatternDetector'

import type { PerfContextValue } from '../context/PerfContext'

const MAX_EVENTS = 1000

export function useStreamState() {

    const {
        interceptors,
        addInterceptor,
        removeInterceptor,
        renameInterceptor,
        updateInterceptorCode,
        toggleInterceptor,
        reorderInterceptors,
        applyInterceptors,
        hasActiveInterceptors,
    } = useInterceptors()


    const {
        idbAvailable,
        totalStoredCount,
        saveEvent,
        clearStorage,
        loadHistory,
    } = useEventStorage()

    // Live preview for the InterceptorEditor panel
    const [lastEventPreview, setLastEventPreview] = useState<{
        raw: string
        transformed: string | undefined
    } | undefined>()

    const updatePreview = useCallback((raw: string, transformed: string | undefined) => {
        setLastEventPreview({ raw, transformed })
    }, [])

    const applyInterceptorsWithPreview = useCallback(async (event: any) => {
        const result = await applyInterceptors(event)
        updatePreview(
            JSON.stringify(event, null, 2),
            result ? JSON.stringify(result, null, 2) : undefined
        )
        return result
    }, [applyInterceptors, updatePreview])

    // Stable ref so useSharedStream's onmessage always calls the current interceptor
    const interceptorRef = useRef<((e: any) => Promise<any>) | undefined>(undefined)
    useEffect(() => {
        interceptorRef.current = hasActiveInterceptors ? applyInterceptorsWithPreview : undefined
    }, [applyInterceptorsWithPreview, hasActiveInterceptors])


    const [useProxy, setUseProxy] = useState(true)

    const {
        connected,
        events: allEvents,
        error: connectionError,
        isLoading,
        reconnecting,
        droppedCount,
        connect: connectBase,
        disconnect,
        clearEvents: clearEventsBase,
        replaceEvents,
    } = useSharedStream(
        MAX_EVENTS,
        hasActiveInterceptors ? (e => interceptorRef.current?.(e) ?? Promise.resolve(e)) : undefined,
        idbAvailable ? saveEvent : undefined
    )

    const connect = useCallback((url: string, token?: string) => {
        connectBase(url, token, true, useProxy)
    }, [connectBase, useProxy])

    const isSharedWorkerActive = typeof SharedWorker !== 'undefined'


    const [connectionTime, setConnectionTime] = useState(0)
    useEffect(() => {
        let interval: number
        if (connected) {
            setConnectionTime(0)
            interval = window.setInterval(() => setConnectionTime(prev => prev + 1), 1000)
        }
        return () => clearInterval(interval)
    }, [connected])


    const {
        isPaused,
        currentEventIndex,
        togglePause,
        seekTo,
        stepForward,
        stepBackward,
        goLive,
        displayedEvents: playbackEvents,
    } = usePlayback(allEvents)


    const { profiles, activeProfileTab, setActiveProfileTab, saveProfile: saveProfileHook, deleteProfile } = useProfiles()


    const {
        customFilters,
        newFilterField,
        setNewFilterField,
        getUniqueValuesForField,
        addCustomFilter,
        removeCustomFilter,
        toggleFilterValue,
        clearFilterValues,
        toggleRegexMode,
        setRegexPattern,
    } = useCustomFilters(playbackEvents)

    const { query, setQuery, error: queryError } = useQueryParser()
    const { searchQuery, setSearchQuery } = useEventSearch()


    // The filter engine mirrors the live buffer by event identity (works after the ring buffer is full)
    const {
        filteredEvents,
        filterExecMs,
        isWorkerReady: isFilterWorkerReady,
        clearWorker,
    } = useFilterWorker(allEvents, {
        query,
        queryError: queryError ?? null,
        searchQuery,
        customFilters,
    }, MAX_EVENTS)

    // Load everything stored in IndexedDB (newest first) into the viewer. Works offline.
    const showHistory = useCallback(async (): Promise<number> => {
        const stored = await loadHistory()
        if (stored.length > 0) replaceEvents(stored)
        return stored.length
    }, [loadHistory, replaceEvents])

    const clearEvents = useCallback(() => {
        clearEventsBase()
        clearWorker()
    }, [clearEventsBase, clearWorker])


    const [copiedId, setCopiedId] = useState<string | null>(null)
    const copyToClipboard = useCallback(async (text: string, eventId: string) => {
        try {
            await navigator.clipboard.writeText(text)
            setCopiedId(eventId)
            setTimeout(() => setCopiedId(null), 1500)
        } catch (err) {
            console.error('Error copying:', err)
        }
    }, [])


    const [profileName, setProfileName] = useState('')
    const [url, setUrl] = useState('')
    const [bearerToken, setBearerToken] = useState('')

    const saveProfile = useCallback(() => {
        if (!profileName.trim() || !url.trim()) return
        saveProfileHook(profileName, url, bearerToken)
        setProfileName('')
    }, [profileName, url, bearerToken, saveProfileHook])

    const loadProfile = useCallback((profile: typeof profiles[0]) => {
        setUrl(profile.url)
        setBearerToken(profile.token)
        setActiveProfileTab(profile.name)
    }, [setActiveProfileTab])


    const { streams, mergedEvents, addStream, removeStream, connectStream, disconnectStream, clearStreamEvents } = useMultiStream()


    const {
        fileName: mockFileName,
        isUploading: isMockUploading,
        isServerRunning: isMockRunning,
        speedMs: mockSpeed,
        isLooping: isMockLooping,
        totalEvents: mockTotalEvents,
        uploadError: mockUploadError,
        mockStreamUrl,
        handleFileUpload: handleMockUpload,
        toggleServer: toggleMockServer,
        setSpeedMs: setMockSpeed,
        setIsLooping: setIsMockLooping,
    } = useMockServer()


    const {
        traces, activeTraceId, setActiveTraceId,
        getEventChain, getTraceForEvent, correlationField, traceCount, clearTraces,
    } = useCorrelationTracker(allEvents)


    const {
        rules: patternRules,
        alerts: patternAlerts,
        activeAlerts: activePatternAlerts,
        addRule: addPatternRule,
        removeRule: removePatternRule,
        toggleRule: togglePatternRule,
        dismissAlert: dismissPatternAlert,
        clearAlerts: clearPatternAlerts,
    } = usePatternDetector(allEvents)


    // The filter engine sees every buffered event; while the playhead is in the past (or paused), only
    // events at or before the playhead are visible. Membership is by id, so ties in arrivalTime and
    // eviction from the ring buffer cannot leak newer events into the paused view.
    const visibleFilteredEvents = useMemo(() => {
        if (currentEventIndex === 0) return filteredEvents
        const visible = new Set<string>()
        for (const e of playbackEvents) visible.add(e.id)
        return filteredEvents.filter((e) => visible.has(e.id))
    }, [filteredEvents, currentEventIndex, playbackEvents])

    // perfValue updates on every filter run — isolated from streamValue so
    // StreamContext consumers are NOT re-rendered by filter metric changes
    const perfValue = useMemo<PerfContextValue>(() => ({
        filterExecMs,
        isFilterWorkerReady,
        isSharedWorkerActive,
    }), [filterExecMs, isFilterWorkerReady, isSharedWorkerActive])

    // streamValue only changes on user actions / connection events
    const streamValue = useMemo(() => ({
        // Connection
        connected, isLoading, reconnecting, droppedCount, connectionError, connectionTime,
        connect, disconnect,
        useProxy, setUseProxy,
        // Events
        allEvents, filteredEvents: visibleFilteredEvents, clearEvents, copiedId, copyToClipboard,
        // Playback
        isPaused, currentEventIndex, togglePause, seekTo, stepForward, stepBackward, goLive,
        // Filtering
        searchQuery, setSearchQuery,
        query, setQuery, queryError: queryError ?? null,
        customFilters, newFilterField, setNewFilterField,
        addCustomFilter, removeCustomFilter, toggleFilterValue, clearFilterValues,
        getUniqueValuesForField, toggleRegexMode, setRegexPattern,
        // Interceptors
        interceptors, addInterceptor, removeInterceptor, renameInterceptor, updateInterceptorCode,
        toggleInterceptor, reorderInterceptors, hasActiveInterceptors, lastEventPreview,
        // Storage
        idbAvailable, totalStoredCount, loadHistory, showHistory, clearStorage,
        // Multi-stream
        streams, mergedEvents, addStream, removeStream, connectStream, disconnectStream, clearStreamEvents,
        // Profiles
        profiles, activeProfileTab, setActiveProfileTab, saveProfile, loadProfile, deleteProfile,
        // Profile form fields (for UIContext parallel)
        url, setUrl, bearerToken, setBearerToken, profileName, setProfileName,
        // Mock
        mockFileName, isMockUploading, isMockRunning, mockSpeed, isMockLooping, mockTotalEvents, mockUploadError, mockStreamUrl,
        handleMockUpload, toggleMockServer, setMockSpeed, setIsMockLooping,
        // Correlation Tracing
        traces, activeTraceId, setActiveTraceId,
        getEventChain, getTraceForEvent, correlationField, traceCount, clearTraces,
        // Pattern Detection
        patternRules, patternAlerts, activePatternAlerts,
        addPatternRule, removePatternRule, togglePatternRule, dismissPatternAlert, clearPatternAlerts,
    }), [
        connected, isLoading, reconnecting, droppedCount, connectionError, connectionTime, connect, disconnect, useProxy,
        allEvents, visibleFilteredEvents, clearEvents, copiedId, copyToClipboard,
        isPaused, currentEventIndex, togglePause, seekTo, stepForward, stepBackward, goLive,
        searchQuery, setSearchQuery, query, setQuery, queryError,
        customFilters, newFilterField, setNewFilterField,
        addCustomFilter, removeCustomFilter, toggleFilterValue, clearFilterValues,
        getUniqueValuesForField, toggleRegexMode, setRegexPattern,
        interceptors, addInterceptor, removeInterceptor, renameInterceptor, updateInterceptorCode,
        toggleInterceptor, reorderInterceptors, hasActiveInterceptors, lastEventPreview,
        idbAvailable, totalStoredCount, loadHistory, showHistory, clearStorage,
        streams, mergedEvents, addStream, removeStream, connectStream, disconnectStream, clearStreamEvents,
        profiles, activeProfileTab, setActiveProfileTab, saveProfile, loadProfile, deleteProfile,
        url, bearerToken, profileName,
        mockFileName, isMockUploading, isMockRunning, mockSpeed, isMockLooping, mockTotalEvents, mockUploadError, mockStreamUrl,
        handleMockUpload, toggleMockServer, setMockSpeed, setIsMockLooping,
        traces, activeTraceId, setActiveTraceId, getEventChain, getTraceForEvent, correlationField, traceCount, clearTraces,
        patternRules, patternAlerts, activePatternAlerts, addPatternRule, removePatternRule, togglePatternRule, dismissPatternAlert, clearPatternAlerts,
    ])

    return { streamValue, perfValue }
}

export { MAX_EVENTS }
