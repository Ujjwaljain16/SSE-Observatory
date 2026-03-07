# 🛸 SSE Observatory

<div align="center">
  <img src="./public/logo.png" alt="SSE Observatory Logo" width="160" style="border-radius: 20px;"/>
  <h3>Real-Time Observability for Server-Sent Event Streams</h3>
</div>

## 1. Overview of the Problem Solved

Debugging **Server-Sent Events (SSE)** in production environments is exceptionally difficult. Traditional network inspector tools (like Chrome DevTools) show raw frames but lack advanced filtering, search, and transformation capabilities. Logging to the console quickly becomes overwhelming and leads to browser sluggishness under high-frequency stream conditions.

**SSE Observatory (SSE Tester)** is a complete browser-native debugging and observability toolkit. It allows engineers to inspect, analyze, transform, and replay real-time event streams with powerful structural filtering, trace correlation, and visualization tools—all without requiring external backend logging infrastructure or APMs.

## 2. Key Features

- **Real-Time SSE Monitoring & Multi-Stream Support:** Observe multiple SSE endpoints simultaneously. Each stream is isolated in a dedicated lane, making it trivial to detect cross-service race conditions.
- **Worker-Based Event Processing:** Offloads JSON parsing, indexing, and filtering to dedicated Web Workers, ensuring the React UI remains buttery smooth even at thousands of events per second.
- **Query Engine & Filtering DSL:** A custom query language enabling precise structural filtering (e.g., `type == "payment" AND data.amount > 500`).
- **Event Interception Sandbox:** Write custom JavaScript interceptors on-the-fly to mutate, clean, or drop payloads securely inside an isolated, restricted Worker environment.
- **Dynamic Schema Inference:** Analyzes incoming JSON payloads automatically to produce a live structural representation of the event stream, highlighting data types and field frequencies.
- **Distributed Trace Waterfall:** Automatically identifies common correlation keys (`traceId`, `spanId`, `x-request-id`) to link disjointed events into cohesive causal chains and visual waterfalls.
- **Sliding-Window Pattern Detection:** Detect anomalies using sequence rules (e.g., `A -> B -> C`) or burst rules (e.g., more than 5 errors in a 10s window).
- **Mock Server & Replayable Storage:** Record live sessions, persist them locally via IndexedDB, and replay deterministic scenarios at adjustable speeds without interacting with the live backend.

## 3. System Architecture Explanation

The system is engineered as a high-performance, bounded-memory pipeline that aggressively isolates processing from rendering.

```text
External SSE Servers
       │
       ▼
[ SharedWorker ] — Controls active SSE connections (multiplexing & connection sharing across tabs)
       │
       ▼
[ Ring Buffer ] — In-memory ring buffer ensures O(1) memory bounds
       ├── [ IndexedDB ] — Cold storage eviction & persistent session history
       │
       ▼
[ Filter & Interceptor Workers ] — Executes expensive sandbox modifications, regex, and DSL queries
       │
       ▼
[ React VDOM ] — Virtualized rendering layer displaying highly optimized lists
```

- **Ingestion:** Managed by `sharedSSEWorker.ts`. One connection per URL/token, broadcasting events to any active tabs, preventing duplicate connections to backend servers.
- **Routing & Filtering:** Handled by `filterWorker.ts`. Keeps an in-memory replica, avoiding continuous heavy messaging between the UI and worker.
- **Transformation:** Managed by `interceptorWorker.ts`, which runs a dynamically generated block of code in a locked-down execution context.

## 4. Technology Stack

- **Core/UI:** React 18, TypeScript, Vite, Tailwind CSS
- **Performance:** Native Web Workers, SharedWorkers, TanStack Virtual (for list virtualization)
- **Persistence:** IndexedDB (`idb`, batched transactions)
- **Code Quality/Testing:** ESLint, Vitest (Unit/Integration), Playwright (End-to-End & Soak testing)
- **Monitoring:** Sentry (optional telemetry support)

## 5. Installation Instructions

Requires **Node.js 18+**.

Clone the repository and install dependencies:

```bash
git clone https://github.com/Ujjwaljain16/SSE-Observatory.git
cd sse-tester
npm install
```

## 6. Usage Instructions

To launch the local development server alongside the backend test proxy:

```bash
npm run dev
```

This will concurrently run the Vite UI and a lightweight internal Node API (`server.js`).

1. Open `http://localhost:3000` (or `3001` based on your Vite port).
2. Enter your SSE target URL.
3. Apply filters, interceptors, or simply stream the response live.

To test the resilience of the application against chaos scenarios (dropped connections, heavy bursts):

```bash
npm run dev:all
# (Starts the standard UI + Chaos testing servers)
```

## 7. Project Structure

The codebase strictly segregates responsibilities across `src` and test directories:

```text
src/
  ├── components/    # React visual components (TracePanel, EventTimeline, etc.)
  ├── hooks/         # Complex state & business logic (usePatternDetector, useCorrelationTracker)
  ├── workers/       # Multi-threading logic (filterWorker, sharedSSEWorker, interceptorWorker)
  ├── utils/         # IDB persistence, query parsing, sandbox utilities
  ├── pipeline/      # Core throughput/pipeline logic tests
tests/ / e2e/        # E2E Playwright tests & test configuration
test-servers/        # Specialized Node scripts to produce chaotic/mock SSE data
api/                 # Lightweight proxy logic
```

## 8. Testing Instructions

The testing strategy is heavily optimized for pipeline resilience, memory leaks, and E2E robustness.

- **Unit & Integration tests (Vitest)**
  Run fast, headless tests against utility functions and worker logic:
  ```bash
  npm run test
  npm run test:coverage
  ```

- **End-to-End tests (Playwright)**
  Validates real-browser behaviors, UI rendering, and worker-to-main thread communication:
  ```bash
  npm run test:e2e
  ```

- **Long-Running Soak tests**
  Used to identify memory leaks in the ring buffers under sustained pressure:
  ```bash
  npm run test:soak
  ```

## 9. Key Engineering Decisions

- **Why Web Workers?** Parsing massive amounts of JSON payloads, evaluating regex filters, and running user-provided interceptor code natively blocks the main UI thread. Workers guarantee 60fps scrolling under extreme data pressure.
- **Why SharedWorker connection pooling?** If a user opens 5 tabs viewing the same debugging endpoint, establishing 5 separate SSE connections drains server resources. `SharedWorker` multiplexes a singular connection transparently across all client instances.
- **Why IndexedDB?** LocalStorage has strict storage limits (often ~5MB). IndexedDB supports storing thousands of historical SSE events locally across reloads.
- **Why Virtualization?** Pushing 10,000 DOM nodes representing rows of raw log data crashes browsers. We use UI virtualization to render only the elements visibly occupying the viewport.

## 10. Future Improvements

- **WASM Query Engine:** Migrate the DSL evaluation step to a WebAssembly module for tighter performance loops.
- **Protobuf/gRPC-Web Support:** Broaden the observability toolkit to natively decode raw binary transports beyond stringified JSON.
- **WebSocket Transport Adaptation:** Extend tooling to observe bidirectional WebSocket traffic using a similar shared-worker model.
- **Advanced Trace Analytics:** Implement visual flame-graphs for microservice spans detected via SSE events.

## 11. License

This project is licensed under the MIT License.
