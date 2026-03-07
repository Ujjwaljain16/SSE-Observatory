import http from 'http';

const server = http.createServer((req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

  if (req.method === 'OPTIONS') {
    res.writeHead(200);
    return res.end();
  }

  const parsedUrl = new URL(req.url, `http://${req.headers.host}`);
  const pathname = parsedUrl.pathname;

  if (pathname === '/chaos-stream') {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
    });

    let counter = 0;
    
    // 1. Initial burst
    for (let i = 0; i < 50; i++) {
        counter++;
        res.write(`data: ${JSON.stringify({ id: counter, type: 'burst', data: { val: i } })}\n\n`);
    }

    const interval = setInterval(() => {
      counter++;
      const rand = Math.random();

      if (rand < 0.1) {
        // Malformed JSON (missing closing brace)
        res.write(`data: {"bad": "json"\n\n`);
      } else if (rand < 0.2) {
        // Multi-line event
        res.write(`data: multi\ndata: line\ndata: payload\n\n`);
      } else if (rand < 0.3) {
        // Empty event (heartbeat-like)
        res.write(`:\n\n`);
        res.write(`: heartbeat\n\n`);
      } else if (rand < 0.4) {
        // Missing type
        res.write(`data: ${JSON.stringify({ msg: "no type" })}\n\n`);
      } else if (rand < 0.45) {
        // Drop connection simulation
        res.end();
        clearInterval(interval);
      } else {
        // Normal payload with explicit event type
        res.write(`event: custom\ndata: ${JSON.stringify({ id: counter, type: 'normal', nested: { foo: 'bar', timestamp: Date.now() } })}\n\n`);
      }
    }, 500);

    // High throughput simulation endpoint
  } else if (pathname === '/load-stream') {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
    });

    for (let i = 0; i < 50000; i++) {
        res.write(`data: ${JSON.stringify({ id: i, type: 'load', value: Math.random() })}\n\n`);
    }
    res.end();
  } else if (pathname === '/massive-payload') {
    // 1MB+ Payload simulation
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
    });
    
    // Generate a huge object
    const hugeObject = {};
    for(let i=0; i<30000; i++) {
        hugeObject[`key_${i}`] = `value_for_key_number_${i}_which_takes_up_space`;
    }
    
    // Send it once
    res.write(`data: ${JSON.stringify({ id: "huge-1", type: "massive", data: hugeObject })}\n\n`);
    
    // Send another one after 1 second
    setTimeout(() => {
        res.write(`data: ${JSON.stringify({ id: "huge-2", type: "massive", data: hugeObject })}\n\n`);
        res.end();
    }, 1000);
  } else if (req.url?.startsWith('/api/burst')) {
    // High-count burst endpoint: /api/burst?count=N
    const url = new URL(req.url, 'http://localhost:4000')
    const count = parseInt(url.searchParams.get('count') || '1000', 10)
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
    })
    for (let i = 0; i < count; i++) {
      res.write(`data: ${JSON.stringify({ id: `msg-${i}`, seq: i, type: 'burst', value: Math.random() })}\n\n`)
    }
    res.end()
  } else if (req.url?.startsWith('/api/stream')) {
    // Continuous stream at a given frequency: /api/stream?freq=N (events per second)
    const url = new URL(req.url, 'http://localhost:4000')
    const freq = parseInt(url.searchParams.get('freq') || '1000', 10)
    const intervalMs = Math.max(1, Math.floor(1000 / freq))
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
    })
    let seq = 0
    const iv = setInterval(() => {
      res.write(`data: ${JSON.stringify({ id: `msg-${seq}`, seq, latency: Math.floor(Math.random() * 800), type: 'stream' })}\n\n`)
      seq++
    }, intervalMs)
    req.on('close', () => clearInterval(iv))
  } else {
    res.writeHead(404)
    res.end()
  }
});

const PORT = 4000;
server.listen(PORT, () => {
  console.log(`Chaos SSE Server running at http://localhost:${PORT}/chaos-stream`);
  console.log(`Load SSE Server running at http://localhost:${PORT}/load-stream`);
});
