# Known Limitations

While SSE Observatory is designed as an Enterprise-grade tool, relying entirely on User-Side Browser APIs introduces hard computational boundaries.

## 1. Frame Dropping at Scale 
While the generic ring buffer and memory allocation correctly slice to an `N=5000` payload limitation asynchronously, the **DOM reconciliation algorithm of React 18 is blocking**. A stream receiving exactly `10,500` events per second will force the Virtualized Scroll view to drop rendering frames attempting to repaint the visible window.

**Mitigation:** Write a lightweight JS Sandbox `Interceptor` to proactively drop `null` events you do not explicitly need rendered, keeping the React layout tree manageable.

## 2. Vercel Hobby Network Timeouts
For instances deployed to Vercel targeting production metrics behind CORS protections, the `SharedWorker` connects via the `/api/sse` proxy endpoint. 

The Vercel Serverless "Hobby" Tier enforces a hard `10 second` Execution Limit per function. If your stream persists past 10 seconds, Vercel will aggressively sever the HTTP connection throwing an `ECONNRESET` or `504 Protocol Error`.

**Mitigation:** The `useStreamState` Custom Hook gracefully catches severances, triggers an exponential backoff metric, and instantly requests a localized reconnect to hide the disconnection natively behind the React DOM. Your Event Timeline will just register brief 1 second pauses.

## 3. Infinite Sequence Patterns
The sliding window `Pattern Detection` algorithm must continuously map across the in-memory Ring Buffer continuously via the `usePatternDetector` loop. Registering more than 5 explicit sequence workflow trackers simultaneously against a fast stream will throttle the Event Thread drastically as the algorithmic evaluation complexity scales inversely mapped to array volume.

**Mitigation:** Stick to explicit `Burst Constraints` which execute at `O(1)` against indexed dictionaries instead of traversing generic sequence pathways.
