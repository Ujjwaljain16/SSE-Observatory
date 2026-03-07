/**
 * PerfContext.tsx
 *
 * Holds high-frequency perf metrics that update on every filter run:
 *   filterExecMs        — how long the last filter pass took
 *   isFilterWorkerReady — whether the filter Worker has initialised
 *   isSharedWorkerActive — whether the SharedWorker is being used
 *
 * Isolated from StreamContext so that PerfOverlay re-renders (which happen
 * on every event) do NOT trigger re-renders in EventsList, ConnectionPanel,
 * or any other StreamContext consumer.
 */

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
