# Proxy Diagnostics

The built-in proxy (`/api/sse`) labels everything it writes itself, and reports what it saw from the upstream, so the app can tell "the proxy is alive" from "the origin is alive". Forwarded event bytes are never changed.

## Comment tags

Every comment the proxy writes starts with `sse-proxy`. The browser client labels such comments as proxy bytes, so they never count as upstream liveness.

| Comment | When | Fields |
|---|---|---|
| `: sse-proxy-ping` | once, first bytes of the stream | none |
| `: sse-proxy-meta {json}` | once, right after the ping (the first event boundary) | `status`, `contentType`, `encoding`, `ttfbMs`, `heartbeatMs`, `maxDurationMs` (0 = uncapped) |
| `: sse-proxy hb up_idle=<ms> n=<count>` | every `HEARTBEAT_MS` (default 15 s) while at an event boundary | `up_idle`: ms since the last upstream byte; `n`: heartbeats sent on this stream, starting at 1 |
| `: sse-proxy cap duration=<ms>` | at the duration cap, before `retry: 1000` | ms the stream was open |

Like the old `: keep-alive`, tags are written only between complete events, never inside one. Removing every `: sse-proxy...` comment from the response gives back exactly the bytes the upstream sent.

A heartbeat whose `up_idle` keeps growing means the proxy is alive but the upstream has gone silent: a stall that plain keep-alives would hide.

## Response headers

Set on the 200 stream response. They are same-origin, so the browser client can read them.

| Header | Value |
|---|---|
| `X-SSE-Proxy` | `observatory/1` |
| `X-SSE-Proxy-Heartbeat-Ms` | heartbeat interval in ms |
| `X-SSE-Proxy-Max-Duration` | duration cap in ms, `0` when uncapped |
| `X-SSE-Upstream-Status` | upstream HTTP status |
| `X-SSE-Upstream-Content-Type` | upstream `Content-Type` (the proxy always answers `text/event-stream`) |
| `X-SSE-Upstream-Encoding` | upstream `Content-Encoding`, empty when none |
| `X-SSE-Upstream-Ttfb-Ms` | ms from starting the upstream request to its response headers |

## Turning it off

Diagnostics are on by default. Set `PROXY_DIAGNOSTICS=0` to get the original output: the plain `: sse-proxy-ping`, bare `: keep-alive` heartbeats, no meta or cap comment, and no `X-SSE-*` headers.

## Limits

- Vercel functions have no `res.flush`, so a tagged heartbeat can itself sit in a platform buffer. The heartbeat counter `n` and the arrival cadence of the heartbeats expose this: if `n` jumps or heartbeats arrive in bursts, something between the proxy and the browser is buffering.
- The tags describe what the proxy observed. They cannot tell a slow upstream from a buffering intermediary in front of the proxy.
- The wire format lives in `lib/proxy/diagTags.js` and is mirrored in `src/core/proxyTags.ts`; a contract test fails if the two differ.
