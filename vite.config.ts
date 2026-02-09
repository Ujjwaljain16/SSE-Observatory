import { defineConfig, loadEnv, Plugin } from 'vite'
import react from '@vitejs/plugin-react'
import http from 'http'
import https from 'https'
import url from 'url'

function sseProxyPlugin(): Plugin {
  return {
    name: 'sse-proxy',
    configureServer(server) {
      return () => {
        server.middlewares.use((req: any, res: any, next: any) => {
          if (!req.url?.startsWith('/api/sse')) {
            return next()
          }

          // Habilitar CORS
          res.setHeader('Access-Control-Allow-Origin', '*')
          res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
          res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization')

          if (req.method === 'OPTIONS') {
            res.writeHead(200)
            res.end()
            return
          }

          const queryParams = new url.URLSearchParams(url.parse(req.url, true).search)
          const targetUrl = queryParams.get('url')
          const authHeader = queryParams.get('auth')

          if (!targetUrl) {
            res.writeHead(400, { 'Content-Type': 'application/json' })
            res.end(JSON.stringify({ error: 'Missing url parameter' }))
            return
          }

          try {
            const parsedUrl = new URL(targetUrl)
            const protocol = parsedUrl.protocol === 'https:' ? https : http

            const options: any = {
              method: 'GET',
              headers: {
                'Accept': 'text/event-stream',
                'Cache-Control': 'no-cache',
                'Connection': 'keep-alive',
              }
            }

            if (authHeader) {
              options.headers['Authorization'] = authHeader
            }

            console.log(`[SSE Proxy] Conectando a: ${targetUrl}`)

            const proxyReq = protocol.request(parsedUrl, options, (proxyRes: any) => {
              console.log(`[SSE Proxy] Status: ${proxyRes.statusCode}`)

              if (proxyRes.statusCode === 401) {
                res.writeHead(401, { 'Content-Type': 'text/event-stream' })
                res.write('event: error\n')
                res.write('data: {"error": "Unauthorized - Invalid authentication"}\n\n')
                res.end()
                return
              }

              if (proxyRes.statusCode !== 200) {
                res.writeHead(proxyRes.statusCode || 500, { 'Content-Type': 'text/event-stream' })
                res.write('event: error\n')
                res.write(`data: {"error": "Server returned ${proxyRes.statusCode}"}\n\n`)
                res.end()
                return
              }

              res.writeHead(200, {
                'Content-Type': 'text/event-stream',
                'Cache-Control': 'no-cache',
                'Connection': 'keep-alive',
                'Access-Control-Allow-Origin': '*',
              })

              proxyRes.on('data', (chunk: Buffer) => {
                res.write(chunk)
              })

              proxyRes.on('end', () => {
                res.end()
              })

              proxyRes.on('error', (err: Error) => {
                console.error('[SSE Proxy] Response error:', err.message)
                res.write('event: error\n')
                res.write(`data: {"error": "${err.message}"}\n\n`)
                res.end()
              })
            })

            proxyReq.on('error', (err: Error) => {
              console.error('[SSE Proxy] Request error:', err.message)
              res.writeHead(500, { 'Content-Type': 'application/json' })
              res.end(JSON.stringify({ error: err.message }))
            })

            proxyReq.end()
          } catch (err) {
            console.error('[SSE Proxy] Error:', err instanceof Error ? err.message : String(err))
            res.writeHead(400, { 'Content-Type': 'application/json' })
            res.end(JSON.stringify({ error: 'Invalid URL' }))
          }
        })
      }
    }
  }
}

export default defineConfig(({ command, mode }) => {
  const env = loadEnv(mode, process.cwd(), '')
  
  return {
    plugins: [react(), sseProxyPlugin()],
    server: {
      port: parseInt(env.VITE_PORT || '3000', 10),
      open: true
    }
  }
})
