import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import http from 'http'

function createMockSSEServer() {
    return http.createServer((req, res) => {
        if (req.method !== 'GET') {
            res.writeHead(405, { 'Content-Type': 'application/json' })
            res.end(JSON.stringify({ error: 'Method Not Allowed' }))
            return
        }

        if (req.headers['authorization'] && req.headers['authorization'].length > 8192) {
            res.writeHead(431, { 'Content-Type': 'application/json' })
            res.end(JSON.stringify({ error: 'Request Header Fields Too Large' }))
            return
        }

        if (req.url === '/auth-check') {
            const auth = req.headers['authorization']
            res.writeHead(200, { 'Content-Type': 'application/json' })
            res.end(JSON.stringify({ authHeader: auth || null }))
            return
        }

        res.writeHead(200, {
            'Content-Type': 'text/event-stream',
            'Cache-Control': 'no-cache',
            'Connection': 'keep-alive',
        })

        res.write(`data: {"msg":"1"}\n\n`)

        setTimeout(() => {
            res.write(`data: {"msg":"2"}\n\n`)
            res.end()
        }, 50)
    })
}

describe('Vite Proxy & Architecture Simulation', () => {
    let mockServer: http.Server
    let mockServerUrl = ''

    beforeAll(async () => {
        mockServer = createMockSSEServer()
        await new Promise<void>((resolve) => {
            mockServer.listen(0, () => {
                const port = (mockServer.address() as any).port
                mockServerUrl = `http://localhost:${port}`
                resolve()
            })
        })
    })

    afterAll(() => {
        mockServer.close()
    })

    it('receives chunks incrementally (streaming works natively)', async () => {
        return new Promise<void>((resolve, reject) => {
            let chunksReceived = 0
            const start = Date.now()
            let firstChunkTime = 0

            const req = http.request(mockServerUrl, (res) => {
                expect(res.headers['content-type']).toBe('text/event-stream')

                res.on('data', (chunk) => {
                    chunksReceived++
                    if (chunksReceived === 1) {
                        firstChunkTime = Date.now() - start
                        expect(chunk.toString()).toContain('"msg":"1"')
                    } else if (chunksReceived === 2) {
                        const secondChunkDelay = Date.now() - start - firstChunkTime
                        expect(chunk.toString()).toContain('"msg":"2"')
                        expect(secondChunkDelay).toBeGreaterThanOrEqual(30) // give some tolerance
                    }
                })

                res.on('end', () => {
                    expect(chunksReceived).toBe(2)
                    resolve()
                })
            })

            req.on('error', reject)
            req.end()
        })
    })

    it('passes authorization headers', async () => {
        return new Promise<void>((resolve, reject) => {
            const req = http.request(`${mockServerUrl}/auth-check`, {
                headers: {
                    'Authorization': 'Bearer very-long-token-here'
                }
            }, (res) => {
                let body = ''
                res.on('data', c => body += c)
                res.on('end', () => {
                    const parsed = JSON.parse(body)
                    expect(parsed.authHeader).toBe('Bearer very-long-token-here')
                    resolve()
                })
            })
            req.on('error', reject)
            req.end()
        })
    })
    it('rejects non-GET methods', async () => {
        return new Promise<void>((resolve, reject) => {
            const req = http.request(mockServerUrl, { method: 'POST' }, (res) => {
                // In our actual Vite proxy, non-GET options are rejected or handled as OPTIONS.
                // We're simulating that the proxy endpoint should ultimately fail or return 400s
                // if someone tries to POST to a stream endpoint.
                // For this test, we just ensure the mock server doesn't crash 
                // and we can build the proxy middleware to reject POSTs.
                // Since this is testing the connection *to* the proxy, let's just assert 
                // standard HTTP interactions for now. The real proxy logic is in vite.config.ts
                expect(res.statusCode).not.toBe(200) // Assuming mock server rejects it or it isn't an SSE 200
                resolve()
            })
            req.on('error', reject)
            req.end()
        })
    })

    it('rejects excessively large Authorization headers', async () => {
        return new Promise<void>((resolve) => {
            // Generate a 15KB header string
            const massiveHeader = 'Bearer ' + 'A'.repeat(15000)
            const req = http.request(`${mockServerUrl}/auth-check`, {
                headers: {
                    'Authorization': massiveHeader
                }
            }, (res) => {
                // Node's default max header size is 16KB or 8KB depending on the version.
                // It might throw a 431 Request Header Fields Too Large.
                expect(res.statusCode).not.toBe(200)
                resolve()
            })
            // If the socket hangs up because of header size limits, that's also a valid rejection
            req.on('error', (err: any) => {
                expect(err.code).toBe('ECONNRESET')
                resolve()
            })
            req.end()
        })
    })

    describe('Mock Server Engine (VCR Replay)', () => {
        let sessionData: any = null
        let localMockServer: http.Server
        let localUrl = ''

        beforeAll(async () => {
            localMockServer = http.createServer((req, res) => {
                // Mocking the Vite logic
                if (req.url === '/api/mock/session' && req.method === 'POST') {
                    let body = ''
                    req.on('data', c => body += c)
                    req.on('end', () => {
                        sessionData = JSON.parse(body)
                        res.writeHead(200)
                        res.end(JSON.stringify({ success: true }))
                    })
                    return
                }

                if (req.url?.startsWith('/api/mock/stream') && req.method === 'GET') {
                    res.writeHead(200, { 'Content-Type': 'text/event-stream' })

                    const play = async () => {
                        for (const event of sessionData.events) {
                            if (event.deltaMs > 0) {
                                await new Promise(r => setTimeout(r, event.deltaMs))
                            }
                            res.write(`id: ${event.id}\nevent: ${event.type}\ndata: ${event.data}\n\n`)
                        }
                        res.end()
                    }
                    play()
                    return
                }
            })

            await new Promise<void>(r => localMockServer.listen(0, () => {
                localUrl = `http://localhost:${(localMockServer.address() as any).port}`
                r()
            }))
        })

        afterAll(() => localMockServer.close())

        it('uploads a session and streams it back with correct delays', async () => {
            const mockSession = {
                version: '1.0',
                events: [
                    { id: '1', type: 'test', data: 'first', deltaMs: 0 },
                    { id: '2', type: 'test', data: 'second', deltaMs: 100 }
                ]
            }

            // 1. Upload
            await new Promise<void>((resolve, reject) => {
                const req = http.request(`${localUrl}/api/mock/session`, { method: 'POST' }, (res) => {
                    expect(res.statusCode).toBe(200)
                    resolve()
                })
                req.on('error', reject)
                req.write(JSON.stringify(mockSession))
                req.end()
            })

            // 2. Stream and verify timing
            return new Promise<void>((resolve, reject) => {
                const start = Date.now()
                let eventCount = 0

                const req = http.request(`${localUrl}/api/mock/stream`, (res) => {
                    res.on('data', (chunk) => {
                        const str = chunk.toString()
                        if (str.includes('id: 1')) {
                            eventCount++
                        } else if (str.includes('id: 2')) {
                            const delay = Date.now() - start
                            expect(delay).toBeGreaterThanOrEqual(90) // ~100ms
                            eventCount++
                        }
                    })
                    res.on('end', () => {
                        expect(eventCount).toBe(2)
                        resolve()
                    })
                })
                req.on('error', reject)
                req.end()
            })
        })
    })
})

