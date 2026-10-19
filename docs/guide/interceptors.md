# JavaScript Interceptors

An interceptor is a small piece of JavaScript that runs on every incoming event **before** it enters the event buffer. Use it to unwrap payloads, rewrite fields, or drop noise. Interceptors run in order, and each one receives the output of the previous one.

## The contract

You write a function **body**, not a function declaration. Two variables are in scope:

| Name | What it is |
|---|---|
| `event` | The incoming event (see below). |
| `ctx` | A small, frozen toolbox: `ctx.JSON.parse/stringify`, `ctx.atob`, `ctx.btoa`, `ctx.Math`, `ctx.Date`, `ctx.console.log/warn`. |

Your code must `return` one of:

- the event (modified or not): the pipeline continues with it,
- `null`: the event is dropped.

Returning nothing (or anything else) is an error: the original event is kept and the error is shown on the interceptor.

```typescript
interface InterceptEvent {
  id: string        // internal unique id
  type: string      // SSE event name, "message" by default
  data: string      // the raw payload, always a string
  sseId?: string    // the server's `id:` field, if any
  timestamp: string
}
```

If you return an object with a non-string `data`, it is serialised with `JSON.stringify` for you.

## Examples

### Unwrap a nested payload

```javascript
if (event.type === 'obfuscated_wrapper') {
  const parsed = ctx.JSON.parse(event.data)
  return { ...event, data: ctx.JSON.stringify(parsed.hidden_payload), type: 'clean_payload' }
}
return event
```

### Drop noise

```javascript
if (event.type === 'heartbeat') return null
return event
```

## Security and limits

Interceptors are user-written code, so they run in a locked-down dedicated Worker:

- **No network or storage.** `fetch`, `XMLHttpRequest`, `WebSocket`, `importScripts`, `indexedDB`, `postMessage`, timers and similar globals are removed. `window` and `document` do not exist in a Worker.
- **No escape routes.** `eval`, `Function` and the `constructor` chains that lead back to them are neutralised, and `import` is rejected.
- **100 ms budget.** A call that runs longer than 100 ms (for example `while (true) {}`) gets the Worker killed; a fresh Worker is started and the event is kept unmodified. The interceptor shows "exceeded 100ms".
- **Bounded pool.** A fixed number of Workers is shared by all interceptors; events queue rather than spawn more.

This protects the page from accidents and from pasted snippets, but treat interceptor code like any code you run: only paste code you understand.
