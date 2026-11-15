# Proxy Diagnostics

The built-in proxy (`/api/sse`) labels everything it writes itself, and reports what it saw from the upstream, so the app can tell "the proxy is alive" from "the origin is alive". The upstream's event bytes are forwarded as they came; the one exception is an upstream comment that pretends to be the proxy (see "The namespace belongs to the proxy").

## Comment tags

Every comment the proxy writes starts with `sse-proxy`. The browser client labels such comments as proxy bytes, so they never count as upstream liveness.

| Comment | When | Fields |
|---|---|---|
| `: sse-proxy-ping` | once, first bytes of the stream | none |
| `: sse-proxy-meta {json}` | once, right after the ping (the first event boundary) | `status`, `contentType`, `encoding`, `ttfbMs`, `heartbeatMs`, `maxDurationMs` (0 = uncapped) |
| `: sse-proxy hb up_idle=<ms> n=<count>` | every `HEARTBEAT_MS` (default 15 s) while at an event boundary | `up_idle`: ms since the last upstream byte; `n`: heartbeats sent on this stream, starting at 1 |
| `: sse-proxy cap duration=<ms>` | at the duration cap, before `retry: 1000` | ms the stream was open |
| `: sse-proxy error {"error":"<reason>"}` | when the proxy ends the stream itself after it started (the upstream connection was lost, the byte limit was reached), and the stream is between events | `error`: the reason, as one JSON string |

Like the old `: keep-alive`, tags are written only between complete events, never inside one. Removing every frame that begins `: sse-proxy` from the response gives back the bytes the upstream sent, except for the comments the proxy rewrote (next section).

A heartbeat whose `up_idle` keeps growing means the proxy is alive but the upstream has gone silent: a stall that plain keep-alives would hide.

### The error notice is a comment, not an event

When the proxy ends a stream that had started, it says why with the `error` comment above. It does not write an `event: error` frame: an application listening for events never receives a message the upstream did not send. The reason is kept in the observation as an ordinary `comment` record (`source: "proxy"`, text `sse-proxy error {...}`); `parseProxyComment` reads it as `{ kind: 'error', message }`, and the Doctor's timeline shows it on the connection it ended ("the proxy said: Upstream connection lost"). It is not counted as a proxy heartbeat. If the cut falls inside an event nothing is written (the proxy never writes inside an event), so the notice can be missing; the client then reports the unterminated event instead. An `event: error` that the *upstream* sends is the application's event and is forwarded untouched.

## The namespace belongs to the proxy

The client decides that a comment is the proxy's from its text alone, and the Doctor's rules (R05, R13) read the proxy's heartbeats as the proxy's own statement about the upstream. An upstream that writes `: sse-proxy hb up_idle=9000 n=1` would otherwise make the Doctor report a stall at the origin that is not there. So before the proxy writes any tag of its own, it rewrites every upstream comment line in the namespace:

- A comment line is `:`, then any spaces or tabs (up to 32 are looked past), then `sse-proxy` in any letter case (`SSE-Proxy` too) and anything after it.
- The line gets ` upstream:` inserted right after its colon: `: sse-proxy hb up_idle=9000 n=1` becomes `: upstream: sse-proxy hb up_idle=9000 n=1`, `:sse-proxy-ping` becomes `: upstream:sse-proxy-ping`. The text is kept (the owner of the upstream can still read what it sent), the client labels it as the upstream's, and no parser reads it as a tag. A rewritten line is not rewritten again if the stream passes through a second proxy.
- It is done line by line, wherever the line is: every line of a comment block, a comment inside an event, after a leading byte order mark, with LF, CR or CRLF line ends. A comment cut across network chunks is judged whole: the proxy holds back only the first bytes of a comment line while they could still be the namespace (at most about 40 bytes), and forwards every other line at once. If the stream ends while bytes are held, they are forwarded unchanged.
- Nothing else is changed: event, id, retry and data lines, and every comment outside the namespace, pass byte for byte. This is true with diagnostics on and off; it is not a diagnostics feature, it protects the labelling.

## A target that is not an event stream: HTTP 415

When the target answers `200` with something that is not `text/event-stream` (a web page, JSON, a download), the proxy answers the client **HTTP 415 (Unsupported Media Type)** with a JSON body that names the target's media type, and nothing from the target's own body:

```json
{ "error": "Target answers with text/html, not text/event-stream", "upstreamContentType": "text/html" }
```

The media type is given without its parameters (`text/html; charset=utf-8` becomes `text/html`), `none` when the target sent no `Content-Type`, and is cut to 100 printable characters. It used to be a 502, which the client retries; but the target did answer, and asking again gets the same page, so 415 is **final** for the client: it makes one attempt, ends in the `failed` phase and says "The address answers with text/html, not text/event-stream, so there is nothing to retry." (the single stream, every Multi-Stream lane and the shared worker show the same text). Everything else is unchanged: a target that cannot be reached or answers 5xx is still a 502 and is retried with backoff; 401, 403 and 404 from the target are still passed through as they are.

With diagnostics on, the 415 carries the `X-SSE-Proxy` and `X-SSE-Upstream-*` headers below (the upstream status is `200`, the content type is what the target sent), so the Doctor still raises R01 `proto.content-type` from what was observed. R13 `proxy.upstream-mismatch` does not fire for this answer: the proxy states what it did and presents nothing as a stream. With `PROXY_DIAGNOSTICS=0` there is no `X-SSE-*` header, the client still stops and says why (from the JSON body), and the Doctor sees only the 415 status (`http.status`). A direct connection (proxy off) is unchanged: a wrong content type is fatal and reported as "Server did not return an event stream (Content-Type: ...)".

## Response headers

Set on the 200 stream response, and on the 415 answer above. They are same-origin, so the browser client can read them.

| Header | Value |
|---|---|
| `X-SSE-Proxy` | `observatory/1` |
| `X-SSE-Proxy-Heartbeat-Ms` | heartbeat interval in ms |
| `X-SSE-Proxy-Max-Duration` | duration cap in ms, `0` when uncapped |
| `X-SSE-Upstream-Status` | upstream HTTP status |
| `X-SSE-Upstream-Content-Type` | upstream `Content-Type` (on a stream the proxy always answers `text/event-stream`; on the 415 it answers JSON) |
| `X-SSE-Upstream-Encoding` | upstream `Content-Encoding`, empty when none |
| `X-SSE-Upstream-Ttfb-Ms` | ms from starting the upstream request to its response headers |

## Turning it off

Diagnostics are on by default. Set `PROXY_DIAGNOSTICS=0` and the proxy emits **no proxy-specific diagnostic text and no diagnostic headers**:

- no `X-SSE-*` header;
- no comment in the `sse-proxy` namespace: no ping, no meta, no `hb`, no `cap`, no `error`. The first bytes of the response are the upstream's own (the proxy flushes the headers without writing a byte);
- the keep-alive that holds the connection open through idle timeouts stays, as a plain `: keep-alive` comment. It is outside the reserved namespace on purpose, so the client **cannot tell it from the upstream's own keep-alive** and counts it as the origin speaking. That is the meaning of the switch: with it off, the Doctor cannot separate the proxy's liveness from the origin's, and R13 has nothing to judge ("not evaluated");
- at the duration cap the proxy writes only `retry: 1000` (a plain SSE line), with no `cap` tag;
- when the proxy ends a started stream (the upstream connection was lost, the byte limit was reached), the stream just ends, with no notice of any kind; the client reconnects as it would for any closed stream. The rewrite of upstream comments in the reserved namespace still applies.

## Limits

- Vercel functions have no `res.flush`, so a tagged heartbeat can itself sit in a platform buffer. The heartbeat counter `n` and the arrival cadence of the heartbeats expose this: if `n` jumps or heartbeats arrive in bursts, something between the proxy and the browser is buffering.
- The tags describe what the proxy observed. They cannot tell a slow upstream from a buffering intermediary in front of the proxy.
- The tags are not authenticated. The rewrite above stops an *upstream* from passing for the proxy; it does not stop something *between the proxy and the browser* from writing a tag.
- The rewrite changes the upstream's bytes by ten bytes per comment line in the namespace, so a byte-for-byte comparison with the upstream's own log must account for exactly those lines.
- The wire format lives in `lib/proxy/diagTags.js` and is mirrored in `src/core/proxyTags.ts`; a contract test fails if the two differ.
