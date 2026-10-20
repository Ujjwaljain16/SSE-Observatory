# Mock Server & Replay

Any captured session can be exported to a `.sse-record` file and replayed later from a local URL. This lets you reproduce an incident without access to the original backend.

## Exporting a session

1. Connect to a stream and let events arrive. Events are also saved to IndexedDB (up to 100,000, oldest evicted first).
2. Open the **Storage** panel and click **Export all**. This downloads a `.sse-record` JSON file with the events in order and the time between them (`deltaMs`).

## Replaying a session

1. Open the **Mock Server** tab and upload the file.
2. Choose a speed (**0.5x**, **1x**, **2x**) and whether to **Loop**.
3. Click **Start Mock Server**. The panel shows a private URL like `/api/mock/stream?session=<id>&speed=1&loop=false`.
4. Switch to **Monitor Mode**, paste that URL and connect. Everything else (filters, interceptors, patterns, timeline) works as it does on a live stream. `curl -N` works too.

When a non-looping replay finishes, the server sends an `event: end` message so the client stops instead of reconnecting and replaying again. Looping replays run until you disconnect or stop the server.

## Safety

- Each session has its own unguessable id; one session cannot be read through another.
- Sessions expire after one hour and are deleted when you click **Stop Mock Server**.
- Uploads are validated (event count, total size, `deltaMs` range).
- In production the mock API is off unless `ENABLE_MOCK_API=1` is set. For multi-instance deployments configure KV storage so every instance sees the same sessions.

## Record format

```json
{
  "version": "1.0",
  "events": [
    { "id": "1", "type": "message", "data": "{\"n\":1}", "deltaMs": 0 }
  ]
}
```

`data` must be a string. `type` is merged into JSON payloads as a `type` field when the payload does not have one.

## Replaying a capture (`.sse-capture` v2)

The mock server also takes a [capture](/technical/capture-format), as raw NDJSON (`Content-Type: application/x-ndjson`) or a JSON envelope `{ "capture": "<ndjson text>" }`. Old `.sse-record` files keep working exactly as before.

What is replayed depends on what the capture kept:

| Capture holds | Replay | Response header |
|---|---|---|
| wire bytes (local full-fidelity capture) | each network read is written again at its recorded time, so lumps, frames split across reads and comments reproduce byte for byte | `X-Mock-Fidelity: chunk-faithful` |
| redacted text per read (sanitized export) | the same, with the redacted text: timing-faithful, not byte-identical | `chunk-faithful` |
| only events (an imported v1 recording), or the replay must change what is sent | frames are rebuilt from the events or cut out of the recorded text | `event-level` |

A capture with no payload (nothing but metadata) is refused with a message saying so. The recorder keeps wire bytes only when asked; it is off by default because it makes captures large and able to hold secrets.

**Reconnects.** Each request to a capture session gets the next recorded connection (the first request gets the first connection, the second the second, and the last one repeats), so a capture that contained a reconnect reproduces it. Add `connection=<n>` to pick one.

Query parameters on `/api/mock/stream` for a capture session:

| Parameter | Meaning |
|---|---|
| `speed`, `loop` | as before |
| `honorLastEventId=1` | resume after the `Last-Event-ID` the client sent, across all recorded connections (event-level) |
| `unknownId=from-start\|400\|ignore` | what to do with an id that is not in the capture (default `from-start`) |
| `end=close\|hold\|rst\|end-event` | how a replay ends: a plain close (a client sees a dropped connection and reconnects, the default), keep the connection open, reset it, or send `event: end` |
| `skipIds=a,b`, `dropAfter=<n>` | test aids: leave out frames with these ids; end the connection after n frames or reads |
