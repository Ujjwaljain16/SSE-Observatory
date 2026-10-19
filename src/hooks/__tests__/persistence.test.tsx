import { StrictMode, type ReactNode } from 'react'
import { renderHook, act } from '@testing-library/react'
import { describe, it, expect, beforeEach } from 'vitest'
import { useProfiles } from '../useProfiles'
import { useTheme } from '../useTheme'

// React.StrictMode double-runs effects in development — the situation that used to wipe saved data.
const strict = ({ children }: { children: ReactNode }) => <StrictMode>{children}</StrictMode>

beforeEach(() => {
    localStorage.clear()
    document.documentElement.classList.remove('dark')
})

describe('useProfiles', () => {
    it('keeps saved profiles through a StrictMode double-mount', () => {
        localStorage.setItem('sse-profiles', JSON.stringify([{ name: 'prod', url: 'https://a.test/s', token: '' }]))
        const { result } = renderHook(() => useProfiles(), { wrapper: strict })
        expect(result.current.profiles.map((p) => p.name)).toEqual(['prod'])
        expect(result.current.activeProfileTab).toBe('prod')
        expect(JSON.parse(localStorage.getItem('sse-profiles')!)).toHaveLength(1) // not overwritten with []
    })

    it('saves, updates and deletes, persisting each change', () => {
        const { result } = renderHook(() => useProfiles(), { wrapper: strict })
        act(() => { result.current.saveProfile('a', 'https://a.test', '') })
        act(() => { result.current.saveProfile('b', 'https://b.test', 'tok') })
        act(() => { result.current.saveProfile('a', 'https://a2.test', '') })
        expect(result.current.profiles).toEqual([
            { name: 'a', url: 'https://a2.test', token: '' },
            { name: 'b', url: 'https://b.test', token: 'tok' },
        ])
        expect(JSON.parse(localStorage.getItem('sse-profiles')!)).toHaveLength(2)
        act(() => { result.current.deleteProfile('b') })
        expect(result.current.profiles.map((p) => p.name)).toEqual(['a'])
    })

    it('ignores corrupt or malformed stored data instead of crashing', () => {
        localStorage.setItem('sse-profiles', '{not json')
        expect(renderHook(() => useProfiles()).result.current.profiles).toEqual([])
        localStorage.setItem('sse-profiles', JSON.stringify([{ nope: true }, null, { name: 'ok', url: 'u' }]))
        expect(renderHook(() => useProfiles()).result.current.profiles).toEqual([{ name: 'ok', url: 'u', token: '' }])
    })
})

describe('useTheme', () => {
    it('restores the saved theme and mirrors it on <html> (Tailwind dark mode)', () => {
        localStorage.setItem('sse-theme', 'light')
        const { result } = renderHook(() => useTheme(), { wrapper: strict })
        expect(result.current.theme).toBe('light')
        expect(document.documentElement.classList.contains('dark')).toBe(false)
        expect(localStorage.getItem('sse-theme')).toBe('light') // StrictMode did not reset it to the default
    })

    it('toggles and persists', () => {
        localStorage.setItem('sse-theme', 'dark')
        const { result } = renderHook(() => useTheme())
        expect(document.documentElement.classList.contains('dark')).toBe(true)
        act(() => { result.current.toggleTheme() })
        expect(result.current.theme).toBe('light')
        expect(document.documentElement.classList.contains('dark')).toBe(false)
        expect(localStorage.getItem('sse-theme')).toBe('light')
    })

    it('ignores garbage in storage', () => {
        localStorage.setItem('sse-theme', 'purple')
        expect(['dark', 'light']).toContain(renderHook(() => useTheme()).result.current.theme)
    })
})
