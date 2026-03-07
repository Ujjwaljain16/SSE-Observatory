import { describe, it, expect } from 'vitest'

// We will simulate the behavior of the browser's structured cloning algorithm
// that Web Workers use for postMessage, and verify that massive nested objects
// and large Base64 strings can be transferred without blocking or throwing.

const generateLargeObject = (depth: number, breadth: number): any => {
    if (depth === 0) return 'leaf_node_' + Math.random().toString(36).substring(7)
    const obj: any = {}
    for (let i = 0; i < breadth; i++) {
        obj[`key_${depth}_${i}`] = generateLargeObject(depth - 1, breadth)
    }
    return obj
}

describe('Worker PostMessage Boundary - Large Payloads', () => {

    it('should successfully serialize and deserialize a 5MB base64 string payload in typical worker time', async () => {
        // 5MB of raw string data
        const largeStr = 'A'.repeat(5 * 1024 * 1024)
        const payload = {
            type: 'event',
            data: { largeStr }
        }

        const start = performance.now()
        // Simulate postMessage structured cloning
        const cloned = structuredClone(payload)
        const duration = performance.now() - start

        expect(cloned.data.largeStr.length).toBe(largeStr.length)
        expect(cloned.data.largeStr[0]).toBe('A')

        // Structured clone of a 5MB string should be nearly instantaneous (< 50ms)
        expect(duration).toBeLessThan(100)
    })

    it('should successfully serialize heavily nested JSON objects representing complex API responses', async () => {
        // Generate a deeply nested, wide object (~100k nodes)
        const complexObj = generateLargeObject(5, 10)

        const payload = {
            type: 'event',
            data: complexObj
        }

        const start = performance.now()
        const cloned = structuredClone(payload)
        const duration = performance.now() - start

        expect(cloned.data.key_5_0.key_4_0).toBeDefined()
        // Complex cloning might take longer but shouldn't completely lock the thread
        expect(duration).toBeLessThan(200)
    })
})
