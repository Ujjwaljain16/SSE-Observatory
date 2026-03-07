export default function handler(req, res) {
    const origin = req.headers.origin || req.headers.referer;
    
    const debugInfo = {
        timestamp: new Date().toISOString(),
        env: {
            NODE_ENV: process.env.NODE_ENV,
            VERCEL: process.env.VERCEL,
            VERCEL_URL: process.env.VERCEL_URL,
            PROXY_ALLOWED_ORIGINS_SET: !!process.env.PROXY_ALLOWED_ORIGINS,
            ALLOWED_HOSTS_SET: !!process.env.ALLOWED_HOSTS,
        },
        headers: {
            origin: req.headers.origin,
            referer: req.headers.referer,
            'user-agent': req.headers['user-agent'],
            'x-vercel-id': req.headers['x-vercel-id'],
        },
        securityCheck: {
            isLocal: origin && (origin.includes('localhost:') || origin.includes('127.0.0.1:')),
            isVercel: process.env.VERCEL_URL && origin && origin.includes(process.env.VERCEL_URL),
            originProvided: origin || 'NONE',
        }
    };

    res.status(200).json(debugInfo);
}
