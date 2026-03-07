/**
 * AppProviders.tsx
 *
 * Thin provider wrapper: instantiates context values via useStreamState
 * and useTheme, then nests the four context providers.
 *
 * Context boundaries:
 *   ThemeContext  — theme + toggle
 *   UIContext     — app-mode, panel visibility
 *   StreamContext — all stream state (events, filters, playback, …)
 *   PerfContext   — high-frequency filter/worker metrics (isolated to prevent
 *                   StreamContext consumers from re-rendering on every event)
 *
 * All orchestration (12 hooks + context value assembly) lives in useStreamState.
 */

import { useState, useMemo, type ReactNode } from 'react'
import { useTheme } from '../hooks/useTheme'
import { useStreamState, MAX_EVENTS } from '../hooks/useStreamState'

import { ThemeContext } from './ThemeContext'
import { UIContext } from './UIContext'
import { StreamContext } from './StreamContext'
import { PerfContext } from './PerfContext'

interface Props {
    children: ReactNode
}

export function AppProviders({ children }: Props) {
    // ── Theme ──────────────────────────────────────────────────────────────────
    const { theme, toggleTheme } = useTheme()
    const themeValue = useMemo(() => ({ theme, toggleTheme }), [theme, toggleTheme])

    // ── UI State (app-level panel toggles) ─────────────────────────────────────
    // Connection form fields (url, bearerToken, profileName) live in StreamContext
    // via useStreamState; UIContext only holds view-toggle state.
    const [appMode, setAppMode] = useState<'monitor' | 'mock' | 'multistream'>('monitor')
    const [showStats, setShowStats] = useState(false)
    const [showSchema, setShowSchema] = useState(false)
    const [showInterceptors, setShowInterceptors] = useState(false)

    // ── Stream + Perf state (all 12 hooks assembled by useStreamState) ─────────
    const { streamValue, perfValue } = useStreamState()

    // UIContext still exposes url/bearerToken/profileName from streamValue so
    // AppLayout.tsx and ConnectionPanel can keep reading from useUIContext()
    const uiValue = useMemo(() => ({
        appMode, setAppMode,
        showStats, setShowStats,
        showSchema, setShowSchema,
        showInterceptors, setShowInterceptors,
        url: (streamValue as any).url as string ?? '',
        setUrl: (streamValue as any).setUrl as (v: string) => void,
        bearerToken: (streamValue as any).bearerToken as string ?? '',
        setBearerToken: (streamValue as any).setBearerToken as (v: string) => void,
        profileName: (streamValue as any).profileName as string ?? '',
        setProfileName: (streamValue as any).setProfileName as (v: string) => void,
    }), [appMode, showStats, showSchema, showInterceptors, streamValue])

    return (
        <ThemeContext.Provider value={themeValue}>
            <UIContext.Provider value={uiValue}>
                <StreamContext.Provider value={streamValue}>
                    <PerfContext.Provider value={perfValue}>
                        {children}
                    </PerfContext.Provider>
                </StreamContext.Provider>
            </UIContext.Provider>
        </ThemeContext.Provider>
    )
}

export { MAX_EVENTS }
export type { Props as AppProvidersProps }
