import { useState, useMemo, useEffect } from 'react'
import { useTheme } from './hooks/useTheme'
import { useProfiles } from './hooks/useProfiles'
import { useCustomFilters } from './hooks/useCustomFilters'
import { useQueryParser } from './hooks/useQueryParser'
import { useEventSearch } from './hooks/useEventSearch'
import { useEventStream } from './hooks/useEventStream' // New Hook
import { usePlayback } from './hooks/usePlayback' // New Hook

import { Header } from './components/Header'
import { ProfileTabs } from './components/ProfileTabs'
import { Instructions } from './components/Instructions'
import { ConnectionPanel } from './components/ConnectionPanel'
import { CustomFilters } from './components/CustomFilters'
import { EventsList } from './components/EventsList'
import { Footer } from './components/Footer'
import { QueryInput } from './components/QueryInput'
import { PlaybackControls } from './components/PlaybackControls' // New Component
import { EventTimeline } from './components/EventTimeline' // New Component
import { exportEvents, getEventStats } from './utils/exportUtils'

// Configurable max events
const MAX_EVENTS = 1000

export default function App() {
    const [url, setUrl] = useState('')
    const [bearerToken, setBearerToken] = useState('')
    const [profileName, setProfileName] = useState('')
    const [showStats, setShowStats] = useState(false)
    const [connectionTime, setConnectionTime] = useState(0) // Logic moved to hook? No, keep simplistic for now or move later.

    const { theme, toggleTheme } = useTheme()

    // 1. Core Event Stream Logic (Ring Buffer, Connection)
    const {
        connected,
        events: allEvents, // The full history
        error: connectionError,
        isLoading,
        connect,
        disconnect,
        clearEvents
    } = useEventStream(MAX_EVENTS)

    // 2. Playback & Time Travel Logic
    const {
        isPaused,
        playbackSpeed,
        currentEventIndex,
        togglePause,
        setPlaybackSpeed,
        seekTo,
        stepForward,
        stepBackward,
        goLive,
        displayedEvents: playbackEvents
    } = usePlayback(allEvents)

    const {
        profiles,
        activeProfileTab,
        setActiveProfileTab,
        saveProfile: saveProfileHook,
        deleteProfile
    } = useProfiles()

    // 3. Filtering Logic applied to the current "View Slice" (playbackEvents)
    // We filter what is currently visible, not the entire history in background (unless we want to?)
    // Typically you filter the visible view.
    const eventsToFilter = playbackEvents

    const {
        customFilters,
        newFilterField,
        setNewFilterField,
        filteredEvents: filterProcessedEvents,
        getUniqueValuesForField,
        addCustomFilter,
        removeCustomFilter,
        toggleFilterValue,
        clearFilterValues,
        toggleRegexMode,
        setRegexPattern
    } = useCustomFilters(eventsToFilter)

    const {
        query,
        setQuery,
        error: queryError,
        filteredEvents: queryFilteredEvents
    } = useQueryParser(eventsToFilter)

    const {
        searchQuery,
        setSearchQuery,
    } = useEventSearch(eventsToFilter)

    // Combined Filtering Logic
    const filteredEvents = useMemo(() => {
        let result = eventsToFilter

        // 1. Apply Advanced Query
        if (query.trim() && !queryError) {
            // We need to re-apply the query filter using the hook's logic, 
            // but the hook returns already filtered events based on its input.
            // Since we passed 'eventsToFilter' to useQueryParser, 'queryFilteredEvents' is already filtered by query.
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
    }, [eventsToFilter, query, queryError, queryFilteredEvents, searchQuery, customFilters, filterProcessedEvents])

    // Connection timer
    useEffect(() => {
        let interval: number
        if (connected) {
            setConnectionTime(0)
            interval = window.setInterval(() => {
                setConnectionTime(prev => prev + 1)
            }, 1000)
        }
        return () => clearInterval(interval)
    }, [connected])

    const copyToClipboard = async (text: string, eventId: string) => {
        try {
            await navigator.clipboard.writeText(text)
            // We can add a toast notification here if needed, 
            // but for now let's just log or rely on button state if we had one.
            // Actually, let's add a temporary state for feedback if we want to pass it down.
            // For now, removing the unused variable warning by using it:
            console.log(`Copied event ${eventId} to clipboard`)
        } catch (err) {
            console.error('Error copying:', err)
        }
    }

    const saveProfile = () => {
        if (!profileName.trim() || !url.trim()) return
        saveProfileHook(profileName, url, bearerToken)
        setProfileName('')
    }

    const loadProfile = (profile: typeof profiles[0]) => {
        setUrl(profile.url)
        setBearerToken(profile.token)
        setActiveProfileTab(profile.name)
    }

    const handleConnect = () => {
        connect(url, bearerToken)
    }

    const stats = getEventStats(allEvents) // Stats typically reflect FULL history, not just filtered view

    return (
        <div className={`min-h-screen transition-colors duration-300 overflow-x-hidden pb-20 ${theme === 'dark'
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
                    error={connectionError}
                    connectionTime={connectionTime} // We might want to fix this counter later
                    eventsLength={allEvents.length}
                    onUrlChange={setUrl}
                    onTokenChange={setBearerToken}
                    onProfileNameChange={setProfileName}
                    onSaveProfile={saveProfile}
                    onConnect={handleConnect}
                    onDisconnect={disconnect}
                    onClearEvents={clearEvents}
                />

                {(connected || allEvents.length > 0) && (
                    <>
                        <QueryInput
                            theme={theme}
                            query={query}
                            onQueryChange={setQuery}
                            error={queryError}
                        />

                        {/* Stats & Search Toolbar */}
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
                                <div className="flex gap-2">
                                    <button
                                        onClick={() => exportEvents(filteredEvents, { format: 'json' })}
                                        disabled={filteredEvents.length === 0}
                                        className="px-4 py-2 bg-emerald-600 hover:bg-emerald-700 disabled:bg-slate-600 disabled:cursor-not-allowed text-white font-medium rounded-lg transition-colors text-sm"
                                    >
                                        📤 JSON
                                    </button>
                                    <button
                                        onClick={() => exportEvents(filteredEvents, { format: 'csv' })}
                                        disabled={filteredEvents.length === 0}
                                        className="px-4 py-2 bg-amber-600 hover:bg-amber-700 disabled:bg-slate-600 disabled:cursor-not-allowed text-white font-medium rounded-lg transition-colors text-sm"
                                    >
                                        📤 CSV
                                    </button>
                                </div>
                            </div>

                            {/* Stats Panel */}
                            {showStats && allEvents.length > 0 && (
                                <div className={`mt-4 pt-4 border-t ${theme === 'dark' ? 'border-slate-600' : 'border-slate-200'}`}>
                                    <div className="grid grid-cols-2 md:grid-cols-4 gap-4 mb-4">
                                        <div className={`p-3 rounded-lg ${theme === 'dark' ? 'bg-slate-700' : 'bg-slate-100'}`}>
                                            <div className={`text-sm ${theme === 'dark' ? 'text-slate-400' : 'text-slate-600'}`}>Total Events</div>
                                            <div className={`text-2xl font-bold ${theme === 'dark' ? 'text-white' : 'text-slate-900'}`}>{stats.total}</div>
                                        </div>
                                        <div className={`p-3 rounded-lg ${theme === 'dark' ? 'bg-slate-700' : 'bg-slate-100'}`}>
                                            <div className={`text-sm ${theme === 'dark' ? 'text-slate-400' : 'text-slate-600'}`}>Unique Types</div>
                                            <div className={`text-2xl font-bold ${theme === 'dark' ? 'text-white' : 'text-slate-900'}`}>{stats.uniqueTypes}</div>
                                        </div>
                                        <div className={`p-3 rounded-lg ${theme === 'dark' ? 'bg-slate-700' : 'bg-slate-100'}`}>
                                            <div className={`text-sm ${theme === 'dark' ? 'text-slate-400' : 'text-slate-600'}`}>Filtered</div>
                                            <div className={`text-2xl font-bold ${theme === 'dark' ? 'text-white' : 'text-slate-900'}`}>{filteredEvents.length}</div>
                                        </div>
                                        <div className={`p-3 rounded-lg ${theme === 'dark' ? 'bg-slate-700' : 'bg-slate-100'}`}>
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
                            eventsLength={allEvents.length}
                            filteredEventsLength={filteredEvents.length}
                            onNewFilterFieldChange={setNewFilterField}
                            onAddCustomFilter={addCustomFilter}
                            onRemoveCustomFilter={removeCustomFilter}
                            onToggleFilterValue={toggleFilterValue}
                            onClearFilterValues={clearFilterValues}
                            getUniqueValuesForField={getUniqueValuesForField}
                            onError={(msg) => console.log(msg)} // Simple log for now
                            toggleRegexMode={toggleRegexMode}
                            setRegexPattern={setRegexPattern}
                        />

                        <EventsList
                            theme={theme}
                            connected={connected}
                            filteredEvents={filteredEvents}
                            customFilters={customFilters}
                            copiedId={null} // simplified for now
                            onCopyToClipboard={copyToClipboard}
                        />
                    </>
                )}

                <PlaybackControls
                    theme={theme}
                    isPaused={isPaused}
                    playbackSpeed={playbackSpeed}
                    currentEventIndex={currentEventIndex}
                    totalEvents={allEvents.length}
                    onTogglePause={togglePause}
                    onStepForward={stepForward}
                    onStepBackward={stepBackward}
                    onGoLive={goLive}
                    onSetSpeed={setPlaybackSpeed}
                />

                <Footer theme={theme} />
            </div>

            {/* Sticky Timeline at Bottom */}
            <EventTimeline
                theme={theme}
                events={allEvents}
                currentEventIndex={currentEventIndex}
                onSeek={seekTo}
                maxEvents={MAX_EVENTS}
            />
        </div>
    )
}

