import { useState, useRef, useCallback } from 'react'

interface UseMockServerReturn {
    fileName: string | null
    isUploading: boolean
    isServerRunning: boolean
    speedMs: number
    isLooping: boolean
    totalEvents: number
    uploadError: string | null
    sseRecordData: string | null
    setFileName: (name: string | null) => void
    setIsUploading: (val: boolean) => void
    setIsServerRunning: (val: boolean) => void
    setSpeedMs: (speed: number) => void
    setIsLooping: (val: boolean) => void
    setTotalEvents: (count: number) => void
    setSseRecordData: (data: string | null) => void
    handleFileUpload: (event: React.ChangeEvent<HTMLInputElement>) => void
    /** Starts/stops the mock stream. When starting, resolves with the SSE stream URL to connect to. */
    toggleServer: () => Promise<string | null>
}

export const useMockServer = (): UseMockServerReturn => {
    const [fileName, setFileName] = useState<string | null>(null)
    const [isUploading, setIsUploading] = useState(false)
    const [isServerRunning, setIsServerRunning] = useState(false)
    const [speedMs, setSpeedMs] = useState<number>(1)
    const [isLooping, setIsLooping] = useState(false)
    const [totalEvents, setTotalEvents] = useState<number>(0)
    const [uploadError, setUploadError] = useState<string | null>(null)

    // We store the raw JSON to send when clicking play
    const sseRecordDataRef = useRef<string | null>(null)

    const handleFileUpload = useCallback((event: React.ChangeEvent<HTMLInputElement>) => {
        const file = event.target.files?.[0]
        if (!file) return

        setUploadError(null)
        setIsUploading(true)
        const reader = new FileReader()
        reader.onload = (e) => {
            try {
                const content = e.target?.result as string
                const parsed = JSON.parse(content)
                if (parsed.version && parsed.events) {
                    sseRecordDataRef.current = content
                    setFileName(file.name)
                    setTotalEvents(parsed.events.length)
                } else {
                    setUploadError('Invalid .sse-record format: missing version or events fields.')
                }
            } catch (err) {
                setUploadError('Failed to parse recording file — ensure it is valid JSON.')
            } finally {
                setIsUploading(false)
            }
        }
        reader.readAsText(file)
    }, [])

    const toggleServer = useCallback(async (): Promise<string | null> => {
        if (isServerRunning) {
            try {
                await fetch('/api/mock/session', {
                    method: 'POST',
                    body: JSON.stringify({ events: [] })
                })
                setIsServerRunning(false)
            } catch (e) {
                console.error(e)
            }
            return null
        }

        if (!sseRecordDataRef.current) return null

        try {
            console.log('[useMockServer] Sending session to /api/mock/session')
            const res = await fetch('/api/mock/session', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: sseRecordDataRef.current
            })
            if (res.ok) {
                setIsServerRunning(true)
                // Build the stream URL including the current speed and loop settings
                const speedMultiplier = speedMs > 0 ? (1000 / speedMs) : 1
                const streamUrl = `/api/mock/stream?speed=${speedMultiplier.toFixed(2)}&loop=${isLooping}`
                return streamUrl
            } else {
                const err = await res.text()
                console.error('[useMockServer] Failed to initialize Mock Server:', res.status, err)
                setUploadError(`Server error ${res.status}: ${err}`)
                return null
            }
        } catch (error) {
            console.error(error)
            setUploadError('Mock server network error. Is the dev server running?')
            return null
        }
    }, [isServerRunning, speedMs, isLooping])

    return {
        fileName,
        isUploading,
        isServerRunning,
        speedMs,
        isLooping,
        totalEvents,
        uploadError,
        sseRecordData: sseRecordDataRef.current,
        setFileName,
        setIsUploading,
        setIsServerRunning,
        setSpeedMs,
        setIsLooping,
        setTotalEvents,
        setSseRecordData: (data) => { sseRecordDataRef.current = data },
        handleFileUpload,
        toggleServer
    }
}
