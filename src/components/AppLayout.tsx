// pure layout component reading state exclusively from context
// keeps render cycles separate from complex stream orchestration logic

import { useMemo, useState, useEffect } from 'react'
import { useThemeContext } from '../context/ThemeContext'
import { useUIContext } from '../context/UIContext'
import { useStreamContext } from '../context/StreamContext'
import { usePerfContext } from '../context/PerfContext'
import { useSchemaInference } from '../hooks/useSchemaInference'

import { Header } from './Header'
import { ProfileTabs } from './ProfileTabs'
// Removed Instructions component import
import { ConnectionPanel } from './ConnectionPanel'
import { CustomFilters } from './CustomFilters'
import { EventsList } from './EventsList'
import { Footer } from './Footer'
import { QueryInput } from './QueryInput'
import { PlaybackControls } from './PlaybackControls'
import { EventTimeline } from './EventTimeline'
import { SchemaAnalyzer } from './SchemaAnalyzer'
import { MockServerPanel } from './MockServerPanel'
import { StreamLaneManager } from './StreamLaneManager'
import { InterceptorEditor } from './InterceptorEditor'
import { StoragePanel } from './StoragePanel'
import { TracePanel } from './TracePanel'
import { PatternPanel } from './PatternPanel'
import { PerfOverlay, useEventsPerSec } from './PerfOverlay'
import { exportEvents, getEventStats } from '../utils/exportUtils'

import {
    Activity, Server, Search, BarChart2, Dna, Download, Circle, Layers, Zap, GitBranch, AlertTriangle
} from 'lucide-react'

const MAX_EVENTS = 1000

export function AppLayout() {
    const { theme, toggleTheme } = useThemeContext()
    const {
        appMode, setAppMode,
        showStats, setShowStats,
        showSchema, setShowSchema,
        showInterceptors, setShowInterceptors,
        url, setUrl,
        bearerToken, setBearerToken,
        profileName, setProfileName,
        useProxy, setUseProxy,
    } = useUIContext()

    const {
        connected, isLoading, connectionError, connectionTime,
        connect, disconnect,
        allEvents, filteredEvents, clearEvents, copiedId, copyToClipboard,
        isPaused, currentEventIndex, togglePause, seekTo, stepForward, stepBackward, goLive,
        searchQuery, setSearchQuery,
        query, setQuery, queryError,
        customFilters, newFilterField, setNewFilterField,
        addCustomFilter, removeCustomFilter, toggleFilterValue, clearFilterValues,
        getUniqueValuesForField, toggleRegexMode, setRegexPattern,
        interceptors, addInterceptor, removeInterceptor, renameInterceptor, updateInterceptorCode,
        toggleInterceptor, reorderInterceptors, lastEventPreview,
        idbAvailable, totalStoredCount, loadBefore, clearStorage, replayFromStorage,
        streams, mergedEvents, addStream, removeStream, connectStream, disconnectStream, clearStreamEvents,
        profiles, activeProfileTab, setActiveProfileTab, saveProfile, loadProfile, deleteProfile,
        mockFileName, isMockUploading, isMockRunning, mockSpeed, isMockLooping, mockTotalEvents,
        handleMockUpload, toggleMockServer, setMockSpeed, setIsMockLooping,
        // Correlation tracing
        activeTraceId, setActiveTraceId, getTraceForEvent, traces, traceCount,
        // Pattern detection
        patternRules, activePatternAlerts,
        addPatternRule, removePatternRule, togglePatternRule, dismissPatternAlert, clearPatternAlerts,
    } = useStreamContext()

    const { filterExecMs, isFilterWorkerReady, isSharedWorkerActive } = usePerfContext()

    const [showPatterns, setShowPatterns] = useState(false)
    const [timelineDrawMs, setTimelineDrawMs] = useState(0)
    const eventsPerSec = useEventsPerSec(allEvents.length)

    // global intercept for idb quota exhaustion to degraded gracefully
    const [quotaError, setQuotaError] = useState(false)
    useEffect(() => {
        const handleQuotaExceeded = () => setQuotaError(true)
        window.addEventListener('idb-quota-exceeded', handleQuotaExceeded)
        return () => window.removeEventListener('idb-quota-exceeded', handleQuotaExceeded)
    }, [])

    // compute schema locally to prevent stream context bloat
    const { schema, isAnalyzing } = useSchemaInference(allEvents)

    const stats = useMemo(() => getEventStats(allEvents), [allEvents])

    const handleConnect = () => connect(url, bearerToken)

    return (
        <div className={`min-h-screen transition-colors duration-300 overflow-x-hidden pb-20 ${theme === 'dark' ? 'bg-animated' : 'bg-gradient-to-br from-slate-50 via-white to-slate-100'
            }`}>
            <div className="container mx-auto px-4 py-8">
                <Header theme={theme} onToggleTheme={toggleTheme} />

                {quotaError && (
                    <div className={`mb-6 p-4 rounded-lg flex items-center gap-3 border ${theme === 'dark' ? 'bg-red-900/30 text-red-300 border-red-800' : 'bg-red-50 text-red-800 border-red-200'}`}>
                        <AlertTriangle className="w-5 h-5 flex-shrink-0 text-red-500" />
                        <div className="flex-1">
                            <h3 className="font-bold text-sm">Storage Quota Exceeded</h3>
                            <p className="text-xs mt-0.5 opacity-90">Your browser's IndexedDB storage is full. Background saving to disk has been disabled. Memory buffer will continue to function normally. Please free up space or clear storage from the Stats panel.</p>
                        </div>
                        <button
                            onClick={() => setQuotaError(false)}
                            className={`text-xs px-3 py-1.5 rounded-md transition ${theme === 'dark' ? 'bg-red-800 hover:bg-red-700 text-red-100' : 'bg-red-200 hover:bg-red-300 text-red-900'}`}
                        >
                            Dismiss
                        </button>
                    </div>
                )}


                <div className="flex justify-center mb-8">
                    <div className={`flex p-1 rounded-xl transition-all ${theme === 'dark' ? 'bg-slate-800' : 'bg-slate-200'}`}>
                        {([
                            { key: 'monitor', label: 'Monitor Mode', Icon: Activity, color: 'bg-blue-600' },
                            { key: 'multistream', label: 'Multi-Stream', Icon: Layers, color: 'bg-emerald-600' },
                            { key: 'mock', label: 'Mock Server', Icon: Server, color: 'bg-purple-600' },
                        ] as const).map(({ key, label, Icon, color }) => (
                            <button
                                key={key}
                                onClick={() => {
                                    setAppMode(key)
                                    if (key === 'mock' && connected) disconnect()
                                }}
                                className={`px-6 py-2 rounded-lg font-bold text-sm transition-all flex items-center gap-2 ${appMode === key
                                    ? `${color} text-white shadow-md`
                                    : theme === 'dark' ? 'text-slate-400 hover:text-white' : 'text-slate-500 hover:text-slate-800'
                                    }`}
                            >
                                <Icon className="w-4 h-4" /> {label}
                            </button>
                        ))}
                    </div>
                </div>


                {appMode === 'mock' && (
                    <MockServerPanel
                        theme={theme}
                        fileName={mockFileName}
                        isUploading={isMockUploading}
                        isServerRunning={isMockRunning}
                        speedMs={mockSpeed}
                        isLooping={isMockLooping}
                        totalEvents={mockTotalEvents}
                        onFileUpload={handleMockUpload}
                        onToggleServer={toggleMockServer}
                        onSetSpeed={setMockSpeed}
                        onToggleLooping={() => setIsMockLooping(!isMockLooping)}
                    />
                )}


                {appMode === 'multistream' && (
                    <>
                        <StreamLaneManager
                            theme={theme}
                            streams={streams}
                            onAddStream={addStream}
                            onRemoveStream={removeStream}
                            onConnectStream={connectStream}
                            onDisconnectStream={disconnectStream}
                            onClearStreamEvents={clearStreamEvents}
                        />
                        <EventsList
                            theme={theme}
                            connected={streams.some(s => s.connected)}
                            filteredEvents={mergedEvents}
                            customFilters={[]}
                            copiedId={copiedId}
                            isLive={true}
                            onCopyToClipboard={copyToClipboard}
                        />
                    </>
                )}


                {appMode === 'monitor' && (
                    <>
                        <ProfileTabs
                            profiles={profiles}
                            activeProfileTab={activeProfileTab}
                            theme={theme}
                            onLoadProfile={loadProfile}
                            onDeleteProfile={deleteProfile}
                            onSetActiveTab={(name) => setActiveProfileTab(name)}
                            onDisconnect={disconnect}
                            connected={connected}
                        />

                        <ConnectionPanel
                            theme={theme}
                            url={url}
                            bearerToken={bearerToken}
                            profileName={profileName}
                            connected={connected}
                            isLoading={isLoading}
                            error={connectionError}
                            connectionTime={connectionTime}
                            eventsLength={allEvents.length}
                            onUrlChange={setUrl}
                            onTokenChange={setBearerToken}
                            onProfileNameChange={setProfileName}
                            onSaveProfile={saveProfile}
                            onConnect={handleConnect}
                            onDisconnect={disconnect}
                            onClearEvents={clearEvents}
                            useProxy={useProxy}
                            onProxyToggle={setUseProxy}
                        />
                    </>
                )}


                {appMode === 'monitor' && (
                    <>
                        <QueryInput
                            theme={theme}
                            query={query}
                            onQueryChange={setQuery}
                            error={queryError}
                        />


                        <div className={`mt-6 rounded-lg shadow-xl p-4 mb-6 border ${theme === 'dark' ? 'bg-slate-800 border-slate-700' : 'bg-white border-slate-200'
                            }`}>
                            <div className="flex flex-wrap gap-4 items-center justify-between">

                                <div className="flex-1 min-w-[200px]">
                                    <div className="relative">
                                        <div className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-400">
                                            <Search className="w-4 h-4" />
                                        </div>
                                        <input
                                            type="text"
                                            value={searchQuery}
                                            onChange={e => setSearchQuery(e.target.value)}
                                            placeholder="Search events... (text match)"
                                            data-testid="search-input"
                                            className={`w-full pl-10 pr-4 py-2 rounded-lg border text-sm focus:outline-none focus:ring-2 ${theme === 'dark'
                                                ? 'bg-slate-700 border-slate-600 text-white placeholder-slate-500 focus:border-blue-500 focus:ring-blue-500/50'
                                                : 'bg-slate-50 border-slate-300 text-slate-900 placeholder-slate-400 focus:border-blue-500 focus:ring-blue-500/50'
                                                }`}
                                        />
                                    </div>
                                </div>


                                <div className="flex gap-2">
                                    {([
                                        { key: 'stats', label: 'Stats', Icon: BarChart2, active: showStats, onToggle: () => setShowStats(!showStats), activeColor: 'bg-blue-600' },
                                        { key: 'schema', label: 'Schema', Icon: Dna, active: showSchema, onToggle: () => setShowSchema(!showSchema), activeColor: 'bg-indigo-600' },
                                        {
                                            key: 'patterns', label: 'Patterns',
                                            Icon: AlertTriangle,
                                            active: showPatterns,
                                            onToggle: () => setShowPatterns(!showPatterns),
                                            activeColor: activePatternAlerts.length > 0 ? 'bg-amber-500' : 'bg-amber-600',
                                        },
                                    ] as const).map(({ key, label, Icon, active, onToggle, activeColor }) => (
                                        <button
                                            key={key}
                                            onClick={onToggle}
                                            className={`px-4 py-2 rounded-lg text-sm font-medium transition-colors flex items-center gap-2 ${active
                                                ? `${activeColor} text-white`
                                                : theme === 'dark'
                                                    ? 'bg-slate-700 text-slate-300 hover:bg-slate-600'
                                                    : 'bg-slate-200 text-slate-700 hover:bg-slate-300'
                                                }`}
                                        >
                                            <Icon className="w-4 h-4" /> {label}
                                            {key === 'patterns' && activePatternAlerts.length > 0 && (
                                                <span className="ml-0.5 px-1.5 py-0.5 rounded-full text-xs font-bold bg-white/20">
                                                    {activePatternAlerts.length}
                                                </span>
                                            )}
                                            {key === 'stats' && traceCount > 0 && (
                                                <span className="ml-0.5 inline-flex items-center gap-0.5 px-1.5 py-0.5 rounded-full text-xs font-bold bg-white/20">
                                                    <GitBranch className="w-2.5 h-2.5" />{traceCount}
                                                </span>
                                            )}
                                        </button>
                                    ))}


                                    <button
                                        onClick={() => setShowInterceptors(!showInterceptors)}
                                        className={`px-4 py-2 rounded-lg text-sm font-medium transition-colors flex items-center gap-2 ${interceptors.some(i => i.enabled && i.compiledFn)
                                            ? 'bg-amber-500 text-white'
                                            : showInterceptors
                                                ? 'bg-amber-600 text-white'
                                                : theme === 'dark'
                                                    ? 'bg-slate-700 text-slate-300 hover:bg-slate-600'
                                                    : 'bg-slate-200 text-slate-700 hover:bg-slate-300'
                                            }`}
                                    >
                                        <Zap className="w-4 h-4" />
                                        Interceptors
                                        {interceptors.length > 0 && (
                                            <span className="ml-1 px-1.5 py-0.5 rounded-full text-xs font-bold bg-white/20">
                                                {interceptors.length}
                                            </span>
                                        )}
                                    </button>
                                </div>


                                <div className="flex gap-2">
                                    {([
                                        { fmt: 'json' as const, label: 'JSON', cls: 'bg-emerald-600 hover:bg-emerald-700' },
                                        { fmt: 'csv' as const, label: 'CSV', cls: 'bg-amber-600 hover:bg-amber-700' },
                                        { fmt: 'record' as const, label: 'Record', cls: 'bg-purple-600 hover:bg-purple-700', title: 'Export as a playable Mock Server recording' },
                                    ]).map(({ fmt, label, cls, title }) => (
                                        <button
                                            key={fmt}
                                            onClick={() => exportEvents(filteredEvents, { format: fmt })}
                                            disabled={filteredEvents.length === 0}
                                            title={title}
                                            className={`px-4 py-2 ${cls} disabled:bg-slate-600 disabled:cursor-not-allowed text-white font-medium rounded-lg transition-colors text-sm flex items-center gap-2`}
                                        >
                                            {fmt === 'record'
                                                ? <><Circle className="w-3 h-3 fill-red-500 text-red-500" /> {label}</>
                                                : <><Download className="w-4 h-4" /> {label}</>
                                            }
                                        </button>
                                    ))}
                                </div>
                            </div>


                            {showStats && allEvents.length > 0 && (
                                <div className={`mt-4 pt-4 border-t ${theme === 'dark' ? 'border-slate-600' : 'border-slate-200'}`}>
                                    <StoragePanel
                                        theme={theme}
                                        idbAvailable={idbAvailable}
                                        totalStoredCount={totalStoredCount}
                                        ramBufferCount={allEvents.length}
                                        maxRamBuffer={MAX_EVENTS}
                                        onLoadMore={async () => loadBefore(allEvents.length > 0 ? allEvents[allEvents.length - 1].arrivalTime ?? null : null)}
                                        onClearStorage={clearStorage}
                                        onExportAll={async () => {
                                            const evs = await replayFromStorage()
                                            if (evs.length > 0) exportEvents(evs, { format: 'record' })
                                        }}
                                        onReplayFromStorage={async () => {
                                            const evs = await replayFromStorage()
                                            console.log('[AppLayout] Replay from storage:', evs.length, 'events')
                                        }}
                                    />
                                    <div className="grid grid-cols-2 md:grid-cols-4 gap-4 mb-4 mt-4">
                                        {[
                                            { label: 'Total Events', value: stats.total },
                                            { label: 'Unique Types', value: stats.uniqueTypes },
                                            { label: 'Filtered', value: filteredEvents.length },
                                            { label: 'Max Buffer', value: MAX_EVENTS },
                                        ].map(({ label, value }) => (
                                            <div key={label} className={`p-3 rounded-lg ${theme === 'dark' ? 'bg-slate-700' : 'bg-slate-100'}`}>
                                                <div className={`text-sm ${theme === 'dark' ? 'text-slate-400' : 'text-slate-600'}`}>{label}</div>
                                                <div className={`text-2xl font-bold ${theme === 'dark' ? 'text-white' : 'text-slate-900'}`}>{value}</div>
                                            </div>
                                        ))}
                                    </div>
                                    {stats.topTypes.length > 0 && (
                                        <div>
                                            <div className={`text-sm font-medium mb-2 ${theme === 'dark' ? 'text-slate-300' : 'text-slate-700'}`}>
                                                Top Event Types
                                            </div>
                                            <div className="flex flex-wrap gap-2">
                                                {stats.topTypes.map(([type, count]) => (
                                                    <span
                                                        key={type}
                                                        className={`px-3 py-1 rounded-full text-xs font-medium ${theme === 'dark' ? 'bg-slate-600 text-slate-200' : 'bg-slate-200 text-slate-700'
                                                            }`}
                                                    >
                                                        {type}: {count}
                                                    </span>
                                                ))}
                                            </div>
                                        </div>
                                    )}
                                </div>
                            )}


                            {showSchema && (
                                <SchemaAnalyzer theme={theme} schema={schema} isAnalyzing={isAnalyzing} />
                            )}


                            {showPatterns && (
                                <div className={`mt-4 pt-4 border-t ${theme === 'dark' ? 'border-slate-600' : 'border-slate-200'}`}>
                                    <PatternPanel
                                        theme={theme}
                                        rules={patternRules}
                                        activeAlerts={activePatternAlerts}
                                        onAddRule={addPatternRule}
                                        onRemoveRule={removePatternRule}
                                        onToggleRule={togglePatternRule}
                                        onDismissAlert={dismissPatternAlert}
                                        onClearAlerts={clearPatternAlerts}
                                    />
                                </div>
                            )}


                            {showInterceptors && (
                                <div className={`mt-4 pt-4 border-t ${theme === 'dark' ? 'border-slate-600' : 'border-slate-200'}`}>
                                    <InterceptorEditor
                                        theme={theme}
                                        interceptors={interceptors}
                                        onAdd={() => addInterceptor()}
                                        onRemove={removeInterceptor}
                                        onRename={renameInterceptor}
                                        onUpdateCode={updateInterceptorCode}
                                        onToggle={toggleInterceptor}
                                        onReorder={reorderInterceptors}
                                        {...(lastEventPreview?.raw && { lastEventRaw: lastEventPreview.raw })}
                                        {...(lastEventPreview?.transformed !== undefined && { lastEventTransformed: lastEventPreview.transformed })}
                                    />
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
                            onError={msg => console.log(msg)}
                            toggleRegexMode={toggleRegexMode}
                            setRegexPattern={setRegexPattern}
                        />

                        <EventsList
                            theme={theme}
                            connected={connected}
                            filteredEvents={filteredEvents}
                            customFilters={customFilters}
                            copiedId={copiedId}
                            isLive={currentEventIndex === 0}
                            onCopyToClipboard={copyToClipboard}
                            getTraceForEvent={getTraceForEvent}
                            onViewTrace={setActiveTraceId}
                        />
                    </>
                )}

                {appMode === 'monitor' && (
                    <PlaybackControls
                        theme={theme}
                        isPaused={isPaused}
                        currentEventIndex={currentEventIndex}
                        totalEvents={allEvents.length}
                        onTogglePause={togglePause}
                        onStepForward={stepForward}
                        onStepBackward={stepBackward}
                        onGoLive={goLive}
                    />
                )}

                <Footer theme={theme} />
            </div>


            {appMode === 'monitor' && (
                <EventTimeline
                    theme={theme}
                    events={allEvents}
                    currentEventIndex={currentEventIndex}
                    onSeek={seekTo}
                    maxEvents={MAX_EVENTS}
                    onDrawMs={setTimelineDrawMs}
                />
            )}


            {activeTraceId && (
                <TracePanel
                    theme={theme}
                    trace={traces.get(activeTraceId) ?? null}
                    onClose={() => setActiveTraceId(null)}
                />
            )}


            <PerfOverlay
                filterExecMs={filterExecMs}
                timelineDrawMs={timelineDrawMs}
                eventsPerSec={eventsPerSec}
                isFilterWorkerReady={isFilterWorkerReady}
                isSharedWorkerActive={isSharedWorkerActive}
                totalEvents={allEvents.length}
            />
        </div>
    )
}
