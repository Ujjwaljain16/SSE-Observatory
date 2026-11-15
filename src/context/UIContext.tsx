import { createContext, useContext } from 'react'

export type AppMode = 'monitor' | 'mock' | 'multistream'

/** A request from the Doctor to show one event in the events list. `nonce` makes asking twice for the same event work. */
export interface EventJump { streamId: string; obsSeq: number; nonce: number }
export type JumpResult = 'found' | 'missing' | null

interface UIContextValue {
    appMode: AppMode
    setAppMode: (mode: AppMode) => void
    showStats: boolean
    setShowStats: (v: boolean) => void
    showSchema: boolean
    setShowSchema: (v: boolean) => void
    showInterceptors: boolean
    setShowInterceptors: (v: boolean) => void
    showDoctor: boolean
    setShowDoctor: (v: boolean) => void
    eventJump: EventJump | null
    requestEventJump: (streamId: string, obsSeq: number) => void
    jumpResult: JumpResult
    setJumpResult: (r: JumpResult) => void
    // connection form state lifted from local components
    url: string
    setUrl: (v: string) => void
    bearerToken: string
    setBearerToken: (v: string) => void
    profileName: string
    setProfileName: (v: string) => void
    useProxy: boolean
    setUseProxy: (v: boolean) => void
}

export const UIContext = createContext<UIContextValue | null>(null)

export const useUIContext = (): UIContextValue => {
    const ctx = useContext(UIContext)
    if (!ctx) throw new Error('useUIContext must be used inside <UIProvider>')
    return ctx
}
