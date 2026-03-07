import { createContext, useContext } from 'react'

export type AppMode = 'monitor' | 'mock' | 'multistream'

interface UIContextValue {
    // Mode
    appMode: AppMode
    setAppMode: (mode: AppMode) => void
    // Panel visibility
    showStats: boolean
    setShowStats: (v: boolean) => void
    showSchema: boolean
    setShowSchema: (v: boolean) => void
    showInterceptors: boolean
    setShowInterceptors: (v: boolean) => void
    // Connection form state (lifted out of local)
    url: string
    setUrl: (v: string) => void
    bearerToken: string
    setBearerToken: (v: string) => void
    profileName: string
    setProfileName: (v: string) => void
}

export const UIContext = createContext<UIContextValue | null>(null)

export const useUIContext = (): UIContextValue => {
    const ctx = useContext(UIContext)
    if (!ctx) throw new Error('useUIContext must be used inside <UIProvider>')
    return ctx
}
