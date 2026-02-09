import http from 'http'
import https from 'https'
import url from 'url'
import { readFileSync } from 'fs'

const PORT = process.env.PROXY_PORT || 3001

const server = http.createServer((req, res) => {
  // Habilitar CORS
  res.setHeader('Access-Control-Allow-Origin', '*')
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization')

  if (req.method === 'OPTIONS') {
    res.writeHead(200)
    res.end()
    return
  }

  if (!req.url?.startsWith('/api/sse')) {
    res.writeHead(404, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ error: 'Not found' }))
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

    const options = {
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

    console.log(`Conectando a: ${targetUrl}`)
    if (authHeader) {
      console.log(`Com autenticação: ${authHeader.substring(0, 20)}...`)
    }

    const proxyReq = protocol.request(parsedUrl, options, (proxyRes) => {
      console.log(`Status: ${proxyRes.statusCode}`)
      
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
      })

      proxyRes.on('data', (chunk) => {
        res.write(chunk)
      })

      proxyRes.on('end', () => {
        res.end()
      })

      proxyRes.on('error', (err) => {
        console.error('Proxy response error:', err.message)
        res.write('event: error\n')
        res.write(`data: {"error": "${err.message}"}\n\n`)
        res.end()
      })
    })

    proxyReq.on('error', (err) => {
      console.error('Proxy request error:', err.message)
      res.writeHead(500, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ error: err.message }))
    })

    proxyReq.end()
  } catch (err) {
    console.error('Error:', err instanceof Error ? err.message : String(err))
    res.writeHead(400, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ error: 'Invalid URL' }))
  }
})

server.listen(PORT, () => {
  console.log(`🔗 SSE Proxy Server rodando em http://localhost:${PORT}`)
  console.log(`📡 Use: http://localhost:${PORT}/api/sse?url=<endpoint>&auth=<header>`)
})
