# Getting Started

SSE Observatory is a browser-based tool for inspecting Server-Sent Event (SSE) streams in real time. Parsing, filtering and interceptors run in Web Workers; events are kept in a bounded in-memory buffer and mirrored to IndexedDB.

## Installation

Requires **Node.js 20+**.

```sh
git clone https://github.com/Ujjwaljain16/SSE-Observatory.git
cd SSE-Observatory
npm ci
npm run dev
```

Open `http://localhost:3001`. `npm run dev` starts the Vite UI and the local API server (`server.js`, port 3000) that provides the stream proxy and mock replay API.

## Connecting to a stream

1. **Endpoint:** paste the URL of the SSE stream into the **Connection** panel.
2. **Authentication:** optional bearer token. It is sent as `Authorization: Bearer <token>` and, with the proxy on, in a POST body rather than the URL. Saved profiles do not store the token unless you tick **Remember token**.
3. **Connect.** While connecting you can cancel; if the connection drops you will see a retry countdown.

Leave **Use Server Proxy** on for endpoints that do not send CORS headers. Turn it off to connect straight from the browser (the endpoint must allow your origin).

## Try it with the test servers

In another terminal:

- `npm run simple`: clean heartbeats
- `npm run chaos`: dropped connections, latency and bursts

Run `npm run dev:all` to start the app and the chaos server together. More scenarios live in `test-servers/` (multi-stream, patterns, interceptors).

Local test servers are reachable through the proxy in development. In production the proxy refuses private addresses, so connect directly or self-host with `ALLOW_PRIVATE_TARGETS=1`.
