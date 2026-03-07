import { defineConfig, loadEnv, Plugin } from 'vite'
import react from '@vitejs/plugin-react'
import * as http from 'http'
import * as https from 'https'
import * as url from 'url'

// Max body size accepted on POST /api/mock/session (10 MB)
const MAX_MOCK_BODY_BYTES = 10 * 1024 * 1024

let mockSession: any = null

function sseProxyPlugin(): Plugin {
  return {
    name: 'sse-proxy',
    configureServer(server) {
      server.middlewares.use((req: any, res: any, next: any) => {
        const parsedUrl = url.parse(req.url || '', true)
        const pathName = parsedUrl.pathname

        // 1. OPTIONS / CORS
        if (pathName?.startsWith('/api')) {
          res.setHeader('Access-Control-Allow-Origin', '*')
          res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
          res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization')
          if (req.method === 'OPTIONS') {
            res.writeHead(200)
            res.end()
            return
          }
        }

        // 2. Mock Session Upload
        if (pathName === '/api/mock/session' && req.method === 'POST') {
          let body = ''
          let bodyBytes = 0
          req.on('data', (chunk: Buffer) => {
            bodyBytes += chunk.length
            if (bodyBytes > MAX_MOCK_BODY_BYTES) {
              res.writeHead(413, { 'Content-Type': 'application/json' })
              res.end(JSON.stringify({ error: 'Payload too large (max 10 MB)' }))
              req.destroy()
              return
            }
            body += chunk.toString()
          })
          req.on('end', () => {
            if (res.writableEnded) return
            try {
              mockSession = JSON.parse(body)
              res.writeHead(200, { 'Content-Type': 'application/json' })
              res.end(JSON.stringify({ success: true, events: mockSession.events?.length || 0 }))
            } catch (e) {
              res.writeHead(400, { 'Content-Type': 'application/json' })
              res.end(JSON.stringify({ error: 'Invalid JSON' }))
            }
          })
          return
        }

        // 3. Mock Stream Replay
        if (pathName?.startsWith('/api/mock/stream') && req.method === 'GET') {
          if (!mockSession) {
            res.writeHead(404, { 'Content-Type': 'application/json' })
            res.end(JSON.stringify({ error: 'No mock session loaded' }))
            return
          }
          const speedMultiplier = parseFloat(parsedUrl.query.speed as string || '1') || 1
          const loop = parsedUrl.query.loop === 'true'

          res.writeHead(200, {
            'Content-Type': 'text/event-stream',
            'Cache-Control': 'no-cache',
            'Connection': 'keep-alive',
          })

          let isDestroyed = false
          req.on('close', () => { isDestroyed = true })

          const play = async () => {
            do {
              for (const event of (mockSession.events || [])) {
                if (isDestroyed) return
                const delay = (event.deltaMs || 0) / speedMultiplier
                if (delay > 0) await new Promise(r => setTimeout(r, delay))
                if (isDestroyed) return

                let finalData = event.data
                try {
                  const jj = JSON.parse(event.data)
                  if (!jj.type && event.type) {
                    jj.type = event.type
                    finalData = JSON.stringify(jj)
                  }
                } catch (e) { }

                if (event.id) res.write(`id: ${event.id}\n`)
                finalData.split('\n').forEach((l: string) => res.write(`data: ${l}\n`))
                res.write('\n')
              }
            } while (loop && !isDestroyed)
            if (!isDestroyed) res.end()
          }
          play()
          return
        }

        // 4. SSE Proxy (For Monitor Mode)
        if (pathName === '/api/sse' && req.method === 'GET') {
          const targetUrl = parsedUrl.query.url as string
          if (!targetUrl) {
            res.writeHead(400, { 'Content-Type': 'application/json' })
            res.end(JSON.stringify({ error: 'Missing url' }))
            return
          }
          try {
            const target = new URL(targetUrl)
            const protocol = target.protocol === 'https:' ? https : http
            const proxyReq = protocol.request(target, {
              headers: {
                'Accept': 'text/event-stream',
                ...(parsedUrl.query.auth ? { 'Authorization': parsedUrl.query.auth as string } : {})
              }
            }, (proxyRes) => {
              res.writeHead(proxyRes.statusCode || 200, {
                'Content-Type': 'text/event-stream',
                'Cache-Control': 'no-cache',
                'Connection': 'keep-alive',
                'Access-Control-Allow-Origin': '*',
                'X-Accel-Buffering': 'no'
              })
              proxyRes.pipe(res)
            })
            proxyReq.on('error', (err) => {
              console.error('[Proxy Error]', err.message)
              if (!res.headersSent) {
                res.writeHead(502, {
                  'Content-Type': 'text/event-stream',
                  'Cache-Control': 'no-cache',
                  'Access-Control-Allow-Origin': '*'
                })
              }
              res.write(`event: error\ndata: {"error":"Target server unreachable","details":"${err.message}"}\n\n`)
              res.end()
            })
            proxyReq.end()
          } catch (e: any) {
            console.error('[Proxy Exception]', e.message)
            if (!res.headersSent) {
              res.writeHead(400, {
                'Content-Type': 'text/event-stream',
                'Access-Control-Allow-Origin': '*'
              })
            }
            res.write(`event: error\ndata: {"error":"Invalid proxy request","details":"${e.message}"}\n\n`)
            res.end()
          }
          return
        }

        // 5. Catch-all for /api/mock
        if (pathName?.startsWith('/api/mock')) {
          res.writeHead(404, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ error: 'Mock endpoint not found' }))
          return
        }

        next()
      })
    }
  }
}

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '')
  void env // suppress unused-variable warning

  return {
    plugins: [react(), sseProxyPlugin()],
    server: {
      port: 3001,
      strictPort: true,
      open: true
    }
  }
})
