import { createContext, useContext } from 'react'

export type AppMode = 'monitor' | 'mock' | 'multistream'

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
