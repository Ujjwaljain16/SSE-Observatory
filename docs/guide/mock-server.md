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
