# Known Limitations

## 1. The viewer shows the newest 1,000 events

The in-memory buffer holds 1,000 events. Older events are in IndexedDB (up to 100,000) and can be loaded or exported, but they are not all visible at once. Very high rates are ingested in time-sliced batches and the list is virtualised, so the page stays responsive, but you will only ever see the latest window go by. Use filters, interceptors that drop noise, or the pause control to inspect a moment.

## 2. Hosted deployments cap stream length

On Vercel Hobby the proxy function is limited by the platform (the project config allows up to 60 s and streams are capped at 55 s). When the cap is reached the proxy ends the stream and the browser reconnects automatically, sending `Last-Event-ID` if the target supports it, so you may see a brief pause or a few missed events with targets that cannot resume. Self-host (Docker, or `node server.js` after `npm run build`) and raise `MAX_STREAM_SECONDS` for longer streams.

## 3. The proxy is deliberately restrictive

In production it relays only to `ALLOWED_HOSTS` (or any public host when `PROXY_OPEN=1`), never to private, loopback, link-local or metadata addresses, and only for requests from the app's own origin. Targets that need cookies or custom request headers other than a bearer token are not supported. For local services, turn the proxy off and connect directly (the target must allow CORS), or self-host with `ALLOW_PRIVATE_TARGETS=1`.

## 4. SharedWorker support varies

Some browsers and embedded webviews do not provide a working SharedWorker. The app then runs the connection in the page itself; connections are not shared between tabs in that case.

## 5. Interceptors are bounded

An interceptor call is killed after 100 ms. Heavy transformations on very hot streams add up: keep interceptors small, or move the logic upstream.

## 6. Mock sessions are ephemeral

Mock replay sessions live in server memory (or KV when configured) for one hour. A server restart on a single-instance setup discards them; upload the recording again.
