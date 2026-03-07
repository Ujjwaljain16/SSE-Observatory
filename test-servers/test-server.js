import http from 'http';

const server = http.createServer((req, res) => {
  // CORS Headers
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

  if (req.url === '/test-stream') {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
    });

    const sendEvent = (data) => {
      res.write(`data: ${JSON.stringify(data)}\n\n`);
    };

    let counter = 0;
    const interval = setInterval(() => {
      counter++;
      const time = new Date().toISOString();
      
      // Random event types
      const types = ['message', 'update', 'ping', 'error'];
      const type = types[Math.floor(Math.random() * types.length)];
      
      const payload = {
        id: counter,
        type: type,
        timestamp: time,
        data: {
          value: Math.random() * 100,
          status: Math.random() > 0.5 ? 'active' : 'idle',
          userId: `user-${Math.floor(Math.random() * 10)}`
        }
      };

      sendEvent(payload);

      // Simulate connection close after 60s
      if (counter >= 60) {
        clearInterval(interval);
        res.end();
      }
    }, 1000);

    req.on('close', () => {
      clearInterval(interval);
      console.log('Client disconnected');
    });
  } else {
    res.writeHead(404);
    res.end();
  }
});

const PORT = 8080;
server.listen(PORT, () => {
  console.log(`SSE Test Server running at http://localhost:${PORT}/test-stream`);
});
