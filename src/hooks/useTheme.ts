import { useState, useEffect } from 'react'
import type { Theme } from '../types'

export const useTheme = () => {
    const [theme, setTheme] = useState<Theme>('dark')

    useEffect(() => {
        const saved = localStorage.getItem('sse-theme') as Theme
        if (saved) {
            setTheme(saved)
        }
    }, [])

    useEffect(() => {
        localStorage.setItem('sse-theme', theme)
    }, [theme])

    const toggleTheme = () => {
        setTheme(prev => prev === 'dark' ? 'light' : 'dark')
    }

    return { theme, setTheme, toggleTheme }
}
