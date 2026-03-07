import http from 'http';

const server = http.createServer((req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

  if (req.method === 'OPTIONS') {
    res.writeHead(200);
    return res.end();
  }

  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
  });

  let counter = 1;
  const maxEvents = 5;

  console.log('Simple Stream started...');

  const interval = setInterval(() => {
    if (counter > maxEvents) {
      res.write('event: end\ndata: {"message": "All 5 events delivered."}\n\n');
      res.end();
      clearInterval(interval);
      console.log('Simple Stream completed.');
      return;
    }

    const payload = JSON.stringify({ 
      id: counter, 
      msg: `Event #${counter} of ${maxEvents}`,
      timestamp: new Date().toLocaleTimeString() 
    });

    res.write(`data: ${payload}\n\n`);
    console.log(`Sent: Event #${counter}`);
    counter++;
  }, 2000); // Slow 2-second interval

  req.on('close', () => {
    clearInterval(interval);
  });
});

const PORT = 4001;
server.listen(PORT, () => {
  console.log(`\n🚀 Simple SSE Server running at http://localhost:${PORT}/stream`);
  console.log(`Perfect for learning the flow! (5 events, 2s apart)\n`);
});
