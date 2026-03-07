// orchestrates global context providers
// separates high-frequency metrics (PerfContext) from UI state to prevent render thrashing

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
    const { theme, toggleTheme } = useTheme()
    const themeValue = useMemo(() => ({ theme, toggleTheme }), [theme, toggleTheme])

    // ui context only holds view toggles, connection fields live in stream context
    const [appMode, setAppMode] = useState<'monitor' | 'mock' | 'multistream'>('monitor')
    const [showStats, setShowStats] = useState(false)
    const [showSchema, setShowSchema] = useState(false)
    const [showInterceptors, setShowInterceptors] = useState(false)

    const { streamValue, perfValue } = useStreamState()

    // expose stream connection fields through ui context for backward compatibility
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
