import { useState, useEffect, useCallback } from 'react'
import type { Theme } from '../types'

const STORAGE_KEY = 'sse-theme'

export function initialTheme(): Theme {
    try {
        const saved = localStorage.getItem(STORAGE_KEY)
        if (saved === 'dark' || saved === 'light') return saved
    } catch { /* storage unavailable */ }
    if (typeof window !== 'undefined' && window.matchMedia?.('(prefers-color-scheme: light)').matches) return 'light'
    return 'dark'
}

export const useTheme = () => {
    // Read synchronously so the first render already has the saved theme (an effect-based load briefly
    // writes the default back over the saved value, which loses it under StrictMode).
    const [theme, setTheme] = useState<Theme>(initialTheme)

    useEffect(() => {
        // Tailwind is configured with darkMode: 'class', so the app theme is the single source of truth for dark: variants.
        document.documentElement.classList.toggle('dark', theme === 'dark')
        document.documentElement.style.colorScheme = theme
        try { localStorage.setItem(STORAGE_KEY, theme) } catch { /* storage unavailable */ }
    }, [theme])

    const toggleTheme = useCallback(() => setTheme((prev) => (prev === 'dark' ? 'light' : 'dark')), [])

    return { theme, setTheme, toggleTheme }
}
