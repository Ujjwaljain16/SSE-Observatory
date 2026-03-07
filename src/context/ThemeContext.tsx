import { createContext, useContext } from 'react'
import type { Theme } from '../types'

interface ThemeContextValue {
    theme: Theme
    toggleTheme: () => void
}

export const ThemeContext = createContext<ThemeContextValue | null>(null)

export const useThemeContext = (): ThemeContextValue => {
    const ctx = useContext(ThemeContext)
    if (!ctx) throw new Error('useThemeContext must be used inside <ThemeProvider>')
    return ctx
}
