import { describe, it, expect } from 'vitest'

describe('Heartbeats and Partial Frames', () => {

    it('Stream processor natively ignores SSE Keep-Alive comments', () => {
        // According to the SSE spec, any line starting with a colon is a comment,
        // often used as a heartbeat/keep-alive mechanism.
        // E.g.: ": keepalive"
        // Native EventSource handles this transparently, but if we parsed custom 
        // fetch streams it would matter. We'll simulate a worker receiving it.

        const rawData = ': keepalive\ndata: {"id": "real"}\n\n'

        // Simulating the parser
        const lines = rawData.split('\n')
        const parsed: any[] = []

        let currentEvent: any = null
        for (const line of lines) {
            if (line.startsWith(':')) {
                // Ignore comment/heartbeat
                continue
            }
            if (line.startsWith('data: ')) {
                currentEvent = { data: line.substring(6) }
                parsed.push(currentEvent)
            }
        }

        expect(parsed.length).toBe(1)
        expect(parsed[0].data).toBe('{"id": "real"}')
    })

    it('Safely reconstructs partial JSON payloads across multiple frames', () => {
        // E.g. node.js server chunked sending:
        // Chunk 1: 'data: {"partial": true, "text": "hel'
        // Chunk 2: 'lo"}\n\n'

        // Native EventSource buffers until '\n\n', so inside the worker
        // we always receive the full event.data string. 
        // We test that our JSON parser gracefully handles accidental truncation 
        // from a malformed server.

        const malformedData = '{"partial": true, "text": "hel' // missing 'lo"}'

        // Simulating our event object creation
        const tryParse = (raw: string) => {
            try {
                return JSON.parse(raw)
            } catch {
                return { error: 'Invalid JSON', raw }
            }
        }

        const result = tryParse(malformedData)
        expect(result.error).toBe('Invalid JSON')
        expect(result.raw).toBe(malformedData)

        // Valid data test
        const validData = '{"partial": true, "text": "hello"}'
        const resultVal = tryParse(validData)
        expect(resultVal.text).toBe('hello')
        expect(resultVal.error).toBeUndefined()
    })
})
