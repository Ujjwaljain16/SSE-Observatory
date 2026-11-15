import * as Sentry from '@sentry/node'
import express from 'express'
import cors from 'cors'
import helmet from 'helmet'
import path from 'path'
import compression from 'compression'
import rateLimit from 'express-rate-limit'
import winston from 'winston'

import { handleSseProxy } from './lib/proxy/streamProxy.js'
import { handleMockSession, handleMockStream } from './lib/mock/handlers.js'
import { loadConfig } from './lib/proxy/guard.js'

if (process.env.SENTRY_DSN) {
    Sentry.init({ dsn: process.env.SENTRY_DSN })
}

const logger = winston.createLogger({
    level: process.env.LOG_LEVEL || 'info',
    format: winston.format.combine(winston.format.timestamp(), winston.format.json()),
    transports: [new winston.transports.Console()],
})

const config = loadConfig()
const app = express()
const PORT = process.env.PORT || 3000
// 127.0.0.1 for local development; set HOST=0.0.0.0 inside containers.
const HOST = process.env.HOST || '127.0.0.1'

// Behind a load balancer set TRUST_PROXY (number of hops, or "true") so rate limits see real client IPs.
if (process.env.TRUST_PROXY) {
    const v = process.env.TRUST_PROXY
    app.set('trust proxy', /^\d+$/.test(v) ? Number(v) : v === 'true' ? true : v)
}

app.use(helmet())
// The web app is same-origin; cross-origin access is only needed for local development tooling.
if (!config.production) app.use(cors())
app.use(compression())
app.use(express.json({ limit: '10mb' }))
// A capture can be uploaded as raw NDJSON; its size is capped again before it is parsed.
app.use(express.text({ type: 'application/x-ndjson', limit: '20mb' }))

// Reconnects count as requests, so the window must be generous; connection caps live in the proxy itself.
app.use('/api/', rateLimit({
    windowMs: 15 * 60 * 1000,
    limit: Number(process.env.RATE_LIMIT_MAX) || 600,
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: 'Too many requests, please try again later.' },
}))

app.get('/healthz', (_req, res) => res.status(200).send('OK'))

app.all('/api/sse', (req, res) => handleSseProxy(req, res, { config }))
app.all('/api/mock/session', (req, res) => handleMockSession(req, res, { config, body: req.body }))
app.get('/api/mock/stream', (req, res) => handleMockStream(req, res, { config }))

// Serve the built frontend in production
if (config.production) {
    app.use(express.static(path.join(process.cwd(), 'dist')))
    app.get('/{*splat}', (req, res, next) => {
        if (req.path.startsWith('/api')) return next()
        res.sendFile(path.join(process.cwd(), 'dist', 'index.html'))
    })
}

// A body that is too large or not valid JSON would otherwise come back as Express's HTML error page; the API answers in JSON.
app.use((err, req, res, next) => {
    if (!req.path.startsWith('/api')) return next(err)
    if (err?.type === 'entity.too.large') return res.status(413).json({ error: 'Request body too large (JSON up to 10 MB, NDJSON up to 20 MB)' })
    if (err?.type === 'entity.parse.failed') return res.status(400).json({ error: 'Request body is not valid JSON' })
    return next(err)
})

if (process.env.SENTRY_DSN) Sentry.setupExpressErrorHandler(app)

app.listen(PORT, HOST, () => {
    logger.info(`Backend service listening on http://${HOST}:${PORT}`, {
        environment: process.env.NODE_ENV || 'development',
        proxyOpen: config.open,
        mockApi: config.mockEnabled,
    })
})
