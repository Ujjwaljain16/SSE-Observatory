import { renderHook, act, waitFor } from '@testing-library/react'
import { vi, describe, it, expect, beforeEach, afterEach } from 'vitest'
import { useEventStorage } from '../useEventStorage'
import * as idbUtils from '../../utils/idbUtils'
import type { EventMessage } from '../../types'

// Mock the IDB utilities
vi.mock('../../utils/idbUtils', () => ({
    openDB: vi.fn(),
    putBatch: vi.fn(),
    countAll: vi.fn(),
    deleteOldest: vi.fn(),
    clearStore: vi.fn(),
    getAllAfter: vi.fn(),
    readAllNewestFirst: vi.fn(),
}))

describe('useEventStorage - Quota Failure & Initialization', () => {
    const originalConsoleWarn = console.warn

    beforeEach(() => {
        vi.clearAllMocks()
        console.warn = vi.fn() // Suppress expected warnings in test output
    })

    afterEach(() => {
        console.warn = originalConsoleWarn
    })

    it('should initialize fallback to RAM-only mode if IDB open fails', async () => {
        // Force openDB to reject
        vi.mocked(idbUtils.openDB).mockRejectedValueOnce(new Error('IndexedDB not allowed'))

        const { result } = renderHook(() => useEventStorage())

        // Wait for the async useEffect to run
        await waitFor(() => {
            expect(result.current.idbAvailable).toBe(false)
        })

        // Verify saveEvent safely does nothing when IDB is unavailable (fallback mode)
        act(() => {
            result.current.saveEvent({ id: '1', data: {} } as EventMessage)
        })

        // Fast-forward to ensure flush does not happen
        await new Promise(r => setTimeout(r, 150))
        expect(idbUtils.putBatch).not.toHaveBeenCalled()

        expect(console.warn).toHaveBeenCalledWith(
            '[useEventStorage] IDB unavailable, falling back to RAM-only mode:',
            'IndexedDB not allowed'
        )
    })

    it('should handle QuotaExceededError during flush gracefully without crashing', async () => {
        // Setup successful init
        const mockDb = {} as IDBDatabase
        vi.mocked(idbUtils.openDB).mockResolvedValue(mockDb)
        vi.mocked(idbUtils.countAll).mockResolvedValue(0)

        // Force putBatch to fail with Quota Exceeded
        const quotaError = new DOMException('Quota Exceeded', 'QuotaExceededError')
        vi.mocked(idbUtils.putBatch).mockRejectedValueOnce(quotaError)

        const { result } = renderHook(() => useEventStorage())

        // Wait for init
        await waitFor(() => {
            expect(result.current.idbAvailable).toBe(true)
        })

        // Queue an event
        act(() => {
            result.current.saveEvent({ id: 'evt-1', data: {} } as EventMessage)
            // Force flush queue size trigger by adding 50 items
            for (let i = 0; i < 50; i++) {
                result.current.saveEvent({ id: `evt-bulk-${i}`, data: {} } as EventMessage)
            }
        })

        // Wait for the queue flush
        await waitFor(() => {
            expect(idbUtils.putBatch).toHaveBeenCalled()
        })

        // Should not have crashed, but caught the error
        expect(console.warn).toHaveBeenCalledWith('[useEventStorage] Flush failed:', quotaError)

        // App is still running fine but IDB is disabled
        await waitFor(() => expect(result.current.idbAvailable).toBe(false))
    })
})
