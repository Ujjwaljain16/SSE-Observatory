// isolates high-frequency performance metrics from main stream context
// prevents events list and connection panels from re-rendering on every metric update

import { createContext, useContext } from 'react'

export interface PerfContextValue {
    filterExecMs: number
    isFilterWorkerReady: boolean
    isSharedWorkerActive: boolean
}

export const PerfContext = createContext<PerfContextValue | null>(null)

export const usePerfContext = (): PerfContextValue => {
    const ctx = useContext(PerfContext)
    if (!ctx) throw new Error('usePerfContext must be used inside <AppProviders>')
    return ctx
}
