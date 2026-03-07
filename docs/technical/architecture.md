# Architecture & WebWorkers

Traditional browser dashboards struggle to render data streams exceeding `1,000` events per second without causing disastrous UI locking and dropped frames. SSE Observatory achieves throughputs pushing **thousands of EPS** entirely inside the browser by completely ditching singular-thread constraints.

## WebWorker Thread Pool

To prevent the `window` DOM thread from locking the UI, calculations are dispatched to four custom `WebWorkers`.

### 1. `sharedSSEWorker.ts`
This is an exceedingly rare **SharedWorker singleton**. Instead of opening 5 duplicate SSE TCP sockets if you have 5 browser tabs open, the `SharedWorker` maintains exactly **1 connection**, and broadcasts raw string payloads up to all listening GUI contexts via `MessagePort` channels. It automatically handles ping heartbeats and Exponential Backoff reconnects.

### 2. `timelineWorker.ts`
When raw events arrive, they are instantly shipped to the Timeline Worker where they are mapped to `VirtualScroll` layout models to construct immutable state trees that the React layer renders seamlessly.

### 3. `filterWorker.ts`
When the UI specifies a complex DSL condition (e.g. `user.id == "123"`), the AST string is compiled and dispatched to the Filter Worker. 

The Filter worker runs a highly optimized structural loop over the Ring Buffer payload. Only the resulting `Ids` matching the queries are posted back to the main thread.

### 4. `interceptorWorker.ts`
Creates a sequestered Javascript parsing Sandbox preventing XSS and catastrophic UI freezes. Incoming events are dispatched, subjected to the `eval()` User-Defined string, and parsed back into strictly typed `Event Payload` interfaces before being stored.

## Ring Buffer Eviction

If processing is decoupled from rendering, what prevents the memory threshold causing browser out-of-memory (OOM) crashes on streams running for hours?

The `useEventStorage` hook relies on a strict Ring Buffer limitation (defaulting to the most recent `5,000` payloads). When an event is pushed, the array is synchronously sliced to enforce maximum array length size limits.

All dumped (older) events are cleanly piped down into an `IndexedDB` backend (utilizing `idbUtils`) preventing the `window` limit from exhausting, while retaining the historical context if the user selects the **Export Session Log** command.
