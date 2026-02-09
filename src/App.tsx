import { useState, useRef, useEffect, useMemo } from 'react'
import type { EventMessage } from './types'
import { useTheme } from './hooks/useTheme'
import { useProfiles } from './hooks/useProfiles'
import { useCustomFilters } from './hooks/useCustomFilters'
import { useQueryParser } from './hooks/useQueryParser'
import { useEventSearch } from './hooks/useEventSearch' // Keep this import for now, though its direct output is replaced
import { Header } from './components/Header'
import { ProfileTabs } from './components/ProfileTabs'
import { Instructions } from './components/Instructions'
import { ConnectionPanel } from './components/ConnectionPanel'
import { CustomFilters } from './components/CustomFilters'
import { EventsList } from './components/EventsList'
import { Footer } from './components/Footer'
import { QueryInput } from './components/QueryInput' // New import
import { exportEvents, getEventStats } from './utils/exportUtils'

// Configurable max events - can be changed or made into an env variable
// Configurable max events - can be changed or made into an env variable
const MAX_EVENTS = 500

export default function App() {
    const [url, setUrl] = useState('')
    const [bearerToken, setBearerToken] = useState('')
    const [profileName, setProfileName] = useState('')
    const [connected, setConnected] = useState(false)
    const [events, setEvents] = useState<EventMessage[]>([])
    const [error, setError] = useState<string>('')
    const [isLoading, setIsLoading] = useState(false)
    const [copiedId, setCopiedId] = useState<string | null>(null)
    const [connectionTime, setConnectionTime] = useState(0)
    const [showStats, setShowStats] = useState(false)

    const eventSourceRef = useRef<EventSource | null>(null)
    const eventCounterRef = useRef(0)
    const timerIntervalRef = useRef<number | null>(null)
    const reconnectAttemptRef = useRef(0)
    const maxReconnectAttempts = 3

    const { theme, toggleTheme } = useTheme()
    const {
        profiles,
        activeProfileTab,
        setActiveProfileTab,
        saveProfile: saveProfileHook,
        deleteProfile
    } = useProfiles()

    const {
        customFilters,
        newFilterField,
        setNewFilterField,
        filteredEvents: filterProcessedEvents, // We use this for unique value extraction
        getUniqueValuesForField,
        addCustomFilter,
        removeCustomFilter,
        toggleFilterValue,
        clearFilterValues,
        toggleRegexMode,
        setRegexPattern
    } = useCustomFilters(events)

    const {
        query,
        setQuery,
        error: queryError,
        filteredEvents: queryFilteredEvents
    } = useQueryParser(events)

    const {
        searchQuery,
        setSearchQuery,
        // searchedEvents // We'll implement our own combined filtering
    } = useEventSearch(events) // Pass base events, but we won't use its output directly

    // Combined Filtering Logic:
    // Flow: Base Events -> Query Filter -> Search -> Custom Filters
    const filteredEvents = useMemo(() => {
        let result = events

        // 1. Apply Advanced Query (Highest Priority)
        if (query.trim() && !queryError) {
            result = queryFilteredEvents
        }

        // 2. Apply Search
        if (searchQuery.trim()) {
            const queryLower = searchQuery.toLowerCase()
            result = result.filter(event =>
                event.type.toLowerCase().includes(queryLower) ||
                JSON.stringify(event.data).toLowerCase().includes(queryLower) ||
                event.timestamp.toLowerCase().includes(queryLower) ||
                event.id.toString().includes(queryLower)
            )
        }

        // 3. Apply Custom Filters
        if (customFilters.length > 0) {
            result = result.filter(event => {
                return customFilters.every(filter => {


                    // Actually, let's just duplicate the access logic or expose it.
                    // Simple path access for now:
                    let val: any = undefined
                    if (filter.field === 'type') val = event.type
                    else if (filter.field === 'id') val = event.id
                    else if (filter.field.startsWith('data.')) {
                        const path = filter.field.split('.').slice(1)
                        val = path.reduce((obj: any, key) => obj?.[key], event.data)
                    } else {
                        val = (event as any)[filter.field]
                    }

                    if (filter.isRegex) {
                        if (!filter.regexPattern) return true
                        try {
                            const regex = new RegExp(filter.regexPattern, 'i')
                            return val !== undefined && val !== null && regex.test(String(val))
                        } catch {
                            return true
                        }
                    }

                    if (filter.activeValues.size === 0) return true
                    return val !== undefined && val !== null && filter.activeValues.has(String(val))
                })
            })
        }

        return result
    }, [events, query, queryError, queryFilteredEvents, searchQuery, customFilters, filterProcessedEvents])

    // Connection timer
    useEffect(() => {
        if (connected) {
            setConnectionTime(0)
            timerIntervalRef.current = window.setInterval(() => {
                setConnectionTime(prev => prev + 1)
            }, 1000)
        } else {
            if (timerIntervalRef.current) {
                clearInterval(timerIntervalRef.current)
                timerIntervalRef.current = null
            }
            setConnectionTime(0)
        }
        return () => {
            if (timerIntervalRef.current) {
                clearInterval(timerIntervalRef.current)
            }
        }
    }, [connected])

    const copyToClipboard = async (text: string, eventId: string) => {
        try {
            await navigator.clipboard.writeText(text)
            setCopiedId(eventId)
            setTimeout(() => setCopiedId(null), 2000)
        } catch (err) {
            console.error('Error copying:', err)
        }
    }

    const saveProfile = () => {
        if (!profileName.trim() || !url.trim()) {
            setError('Enter a name and URL to save the profile')
            setTimeout(() => setError(''), 2000)
            return
        }

        saveProfileHook(profileName, url, bearerToken)
        setProfileName('')
    }

    const loadProfile = (profile: typeof profiles[0]) => {
        setUrl(profile.url)
        setBearerToken(profile.token)
        setError('')
        setActiveProfileTab(profile.name)
    }

    const connectToSSE = async () => {
        if (!url.trim()) {
            setError('Please enter a valid URL')
            return
        }

        setIsLoading(true)
        setError('')
        setEvents([])
        eventCounterRef.current = 0
        reconnectAttemptRef.current = 0

        try {
            const authParam = bearerToken ? `&auth=${encodeURIComponent(bearerToken)}` : ''
            const eventSource = new EventSource(`/api/sse?url=${encodeURIComponent(url)}${authParam}`)
            eventSourceRef.current = eventSource

            eventSource.onopen = () => {
                setConnected(true)
                setIsLoading(false)
                setError('')
                reconnectAttemptRef.current = 0
            }

            eventSource.onerror = (err) => {
                console.error('SSE Error:', err)
                const readyState = eventSource.readyState

                if (readyState === EventSource.CLOSED) {
                    // Attempt reconnection
                    if (reconnectAttemptRef.current < maxReconnectAttempts) {
                        reconnectAttemptRef.current++
                        setError(`Connection lost. Reconnecting... (${reconnectAttemptRef.current}/${maxReconnectAttempts})`)
                        setTimeout(() => {
                            if (eventSourceRef.current) {
                                eventSourceRef.current.close()
                            }
                            connectToSSE()
                        }, 2000 * reconnectAttemptRef.current)
                        return
                    }
                    setError('Connection closed by server. Max reconnection attempts reached.')
                } else if (readyState === EventSource.CONNECTING) {
                    setError('Failed to connect. Check URL and authentication.')
                } else {
                    setError('Connection error occurred')
                }

                disconnect()
            }

            eventSource.onmessage = (event) => {
                let parsedType: string | undefined = undefined
                try {
                    const parsed = JSON.parse(event.data)
                    if (parsed && typeof parsed === 'object' && 'type' in parsed) {
                        parsedType = String(parsed.type)
                    }
                } catch {
                    // Not JSON or no type field
                }

                const newEvent: EventMessage = {
                    id: String(eventCounterRef.current++),
                    timestamp: new Date().toLocaleTimeString('en-US', {
                        hour: '2-digit',
                        minute: '2-digit',
                        second: '2-digit',
                    }),
                    type: 'message',
                    data: event.data,
                    raw: JSON.stringify(event, null, 2),
                    ...(parsedType && { parsedType }),
                }
                setEvents((prev) => [newEvent, ...prev.slice(0, MAX_EVENTS - 1)])
            }
        } catch (err) {
            console.error('Connection error:', err)
            setError('Failed to establish connection')
            setIsLoading(false)
        }
    }

    const disconnect = () => {
        if (eventSourceRef.current) {
            eventSourceRef.current.close()
            eventSourceRef.current = null
        }
        setConnected(false)
        setIsLoading(false)
        reconnectAttemptRef.current = 0
    }

    const clearEvents = () => {
        setEvents([])
        eventCounterRef.current = 0
    }

    const handleExport = (format: 'json' | 'csv') => {
        if (events.length === 0) {
            setError('No events to export')
            setTimeout(() => setError(''), 2000)
            return
        }
        exportEvents(filteredEvents.length > 0 ? filteredEvents : events, { format })
    }

    const stats = getEventStats(events)

    useEffect(() => {
        return () => {
            if (eventSourceRef.current) {
                eventSourceRef.current.close()
            }
        }
    }, [])

    return (
        <div className={`min-h-screen transition-colors duration-300 overflow-x-hidden ${theme === 'dark'
            ? 'bg-animated'
            : 'bg-gradient-to-br from-slate-50 via-white to-slate-100'
            }`}>
            <div className="container mx-auto px-4 py-8">
                <Header theme={theme} onToggleTheme={toggleTheme} />

                <ProfileTabs
                    profiles={profiles}
                    activeProfileTab={activeProfileTab}
                    theme={theme}
                    onLoadProfile={loadProfile}
                    onDeleteProfile={deleteProfile}
                    onSetActiveTab={setActiveProfileTab}
                    onDisconnect={disconnect}
                    connected={connected}
                />

                <Instructions theme={theme} />

                <ConnectionPanel
                    theme={theme}
                    url={url}
                    bearerToken={bearerToken}
                    profileName={profileName}
                    connected={connected}
                    isLoading={isLoading}
                    error={error}
                    connectionTime={connectionTime}
                    eventsLength={events.length}
                    onUrlChange={setUrl}
                    onTokenChange={setBearerToken}
                    onProfileNameChange={setProfileName}
                    onSaveProfile={saveProfile}
                    onConnect={connectToSSE}
                    onDisconnect={disconnect}
                    onClearEvents={clearEvents}
                />

                {/* Show Query Input and Filters when connected or have events */}
                {(connected || events.length > 0) && (
                    <>
                        <QueryInput
                            theme={theme}
                            query={query}
                            onQueryChange={setQuery}
                            error={queryError}
                        />

                        <div className={`mt-6 rounded-lg shadow-xl p-4 mb-6 border ${theme === 'dark'
                            ? 'bg-slate-800 border-slate-700'
                            : 'bg-white border-slate-200'
                            }`}>
                            <div className="flex flex-wrap gap-4 items-center justify-between">
                                {/* Search */}
                                <div className="flex-1 min-w-[200px]">
                                    <div className="relative">
                                        <span className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-400">🔎</span>
                                        <input
                                            type="text"
                                            value={searchQuery}
                                            onChange={(e) => setSearchQuery(e.target.value)}
                                            placeholder="Search events... (text match)"
                                            className={`w-full pl-10 pr-4 py-2 rounded-lg border text-sm focus:outline-none focus:ring-2 ${theme === 'dark'
                                                ? 'bg-slate-700 border-slate-600 text-white placeholder-slate-500 focus:border-blue-500 focus:ring-blue-500/50'
                                                : 'bg-slate-50 border-slate-300 text-slate-900 placeholder-slate-400 focus:border-blue-500 focus:ring-blue-500/50'
                                                }`}
                                        />
                                    </div>
                                </div>

                                {/* Stats Toggle */}
                                <button
                                    onClick={() => setShowStats(!showStats)}
                                    className={`px-4 py-2 rounded-lg text-sm font-medium transition-colors ${showStats
                                        ? 'bg-blue-600 text-white'
                                        : theme === 'dark'
                                            ? 'bg-slate-700 text-slate-300 hover:bg-slate-600'
                                            : 'bg-slate-200 text-slate-700 hover:bg-slate-300'
                                        }`}
                                >
                                    📊 Stats
                                </button>

                                {/* Export Buttons */}
                                <div className="flex gap-2">
                                    <button
                                        onClick={() => handleExport('json')}
                                        disabled={events.length === 0}
                                        className="px-4 py-2 bg-emerald-600 hover:bg-emerald-700 disabled:bg-slate-600 disabled:cursor-not-allowed text-white font-medium rounded-lg transition-colors text-sm"
                                    >
                                        📤 JSON
                                    </button>
                                    <button
                                        onClick={() => handleExport('csv')}
                                        disabled={events.length === 0}
                                        className="px-4 py-2 bg-amber-600 hover:bg-amber-700 disabled:bg-slate-600 disabled:cursor-not-allowed text-white font-medium rounded-lg transition-colors text-sm"
                                    >
                                        📤 CSV
                                    </button>
                                </div>
                            </div>

                            {/* Stats Panel */}
                            {showStats && events.length > 0 && (
                                <div className={`mt-4 pt-4 border-t ${theme === 'dark' ? 'border-slate-600' : 'border-slate-200'
                                    }`}>
                                    <div className="grid grid-cols-2 md:grid-cols-4 gap-4 mb-4">
                                        <div className={`p-3 rounded-lg ${theme === 'dark' ? 'bg-slate-700' : 'bg-slate-100'
                                            }`}>
                                            <div className={`text-sm ${theme === 'dark' ? 'text-slate-400' : 'text-slate-600'}`}>Total Events</div>
                                            <div className={`text-2xl font-bold ${theme === 'dark' ? 'text-white' : 'text-slate-900'}`}>{stats.total}</div>
                                        </div>
                                        <div className={`p-3 rounded-lg ${theme === 'dark' ? 'bg-slate-700' : 'bg-slate-100'
                                            }`}>
                                            <div className={`text-sm ${theme === 'dark' ? 'text-slate-400' : 'text-slate-600'}`}>Unique Types</div>
                                            <div className={`text-2xl font-bold ${theme === 'dark' ? 'text-white' : 'text-slate-900'}`}>{stats.uniqueTypes}</div>
                                        </div>
                                        <div className={`p-3 rounded-lg ${theme === 'dark' ? 'bg-slate-700' : 'bg-slate-100'
                                            }`}>
                                            <div className={`text-sm ${theme === 'dark' ? 'text-slate-400' : 'text-slate-600'}`}>Filtered</div>
                                            <div className={`text-2xl font-bold ${theme === 'dark' ? 'text-white' : 'text-slate-900'}`}>{filteredEvents.length}</div>
                                        </div>
                                        <div className={`p-3 rounded-lg ${theme === 'dark' ? 'bg-slate-700' : 'bg-slate-100'
                                            }`}>
                                            <div className={`text-sm ${theme === 'dark' ? 'text-slate-400' : 'text-slate-600'}`}>Max Buffer</div>
                                            <div className={`text-2xl font-bold ${theme === 'dark' ? 'text-white' : 'text-slate-900'}`}>{MAX_EVENTS}</div>
                                        </div>
                                    </div>
                                    {stats.topTypes.length > 0 && (
                                        <div>
                                            <div className={`text-sm font-medium mb-2 ${theme === 'dark' ? 'text-slate-300' : 'text-slate-700'}`}>Top Event Types</div>
                                            <div className="flex flex-wrap gap-2">
                                                {stats.topTypes.map(([type, count]) => (
                                                    <span key={type} className={`px-3 py-1 rounded-full text-xs font-medium ${theme === 'dark' ? 'bg-slate-600 text-slate-200' : 'bg-slate-200 text-slate-700'
                                                        }`}>
                                                        {type}: {count}
                                                    </span>
                                                ))}
                                            </div>
                                        </div>
                                    )}
                                </div>
                            )}
                        </div>

                        <CustomFilters
                            theme={theme}
                            connected={connected}
                            customFilters={customFilters}
                            newFilterField={newFilterField}
                            eventsLength={events.length}
                            filteredEventsLength={filteredEvents.length}
                            onNewFilterFieldChange={setNewFilterField}
                            onAddCustomFilter={addCustomFilter}
                            onRemoveCustomFilter={removeCustomFilter}
                            onToggleFilterValue={toggleFilterValue}
                            onClearFilterValues={clearFilterValues}
                            getUniqueValuesForField={getUniqueValuesForField}
                            onError={setError}
                            toggleRegexMode={toggleRegexMode}
                            setRegexPattern={setRegexPattern}
                        />

                        <EventsList
                            theme={theme}
                            connected={connected}
                            filteredEvents={filteredEvents}
                            customFilters={customFilters}
                            copiedId={copiedId}
                            onCopyToClipboard={copyToClipboard}
                        />
                    </>
                )}

                <Footer theme={theme} />
            </div>
        </div >
    )
}
