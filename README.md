# 🛸 SSE Observatory

<div align="center">

<img src="./public/logo.png" alt="SSE Observatory Logo" width="160" style="border-radius: 20px;"/>

### Real-Time Observability for Server-Sent Event Streams

Inspect • Filter • Trace • Replay • Transform

Built entirely with **browser-native APIs**
(Web Workers • SharedWorkers • IndexedDB)

> 📚 **[View the Full Documentation Site Locally: `npm run docs:dev`](#)**

</div>

---

# 📡 Overview

**SSE Observatory** is a browser-native debugging and observability toolkit designed for **Server-Sent Events (SSE)**.

It allows engineers to inspect, analyze, transform, and replay real-time event streams with powerful filtering and visualization tools — all **without requiring external logging infrastructure or backend storage**.

The system is designed to run completely inside the browser while maintaining responsive UI performance even under high event throughput.

---

# 🎯 The Problem

Server-Sent Events are widely used for:

* live dashboards
* streaming APIs
* microservice event pipelines
* LLM token streaming
* notifications
* telemetry pipelines

Yet debugging SSE streams in production is difficult.

Traditional tools have limitations:

| Tool            | Limitation                                             |
| --------------- | ------------------------------------------------------ |
| Chrome DevTools | Shows raw frames but lacks filtering/search            |
| Console logging | Impossible to inspect high-frequency streams           |
| APM tools       | Sampling and ingestion latency hide real-time behavior |

When hundreds of events arrive every second, engineers need to answer questions like:

* *Which events match a specific payload condition?*
* *Why did this workflow stall?*
* *What happened immediately before this error?*
* *Are events arriving in the expected order?*

**SSE Observatory transforms raw event streams into a queryable, analyzable timeline.**

---

# ⚙️ Core Architecture

The system separates ingestion, processing, and rendering across multiple browser workers.

```text
External SSE Server
        │
        ▼
SharedWorker (connection manager)
        │
        ▼
Event Processing Pipeline
        │
        ├─ Interceptor Workers
        │
        ▼
Ring Buffer (in-memory)
        │
        ├─ IndexedDB Cold Storage
        │
        ▼
Filter Worker
        │
        ▼
React UI
```

### Key Design Principles

⚡ **UI Thread Isolation**
Heavy computation runs inside Web Workers to prevent UI blocking.

🧠 **Bounded Memory Model**
A ring buffer keeps recent events in memory while persisting older events to IndexedDB.

🔗 **Connection Sharing**
A SharedWorker allows multiple browser tabs to share a single SSE connection.

📊 **Incremental Processing**
Workers receive only new events instead of full dataset transfers.

---

# 🔬 Feature Breakdown

## 🌐 Event Multiplexing (Multi-Stream)

Observe multiple SSE endpoints simultaneously.

Each stream is assigned a dedicated lane on the global timeline, allowing engineers to detect **race conditions or cross-service interactions**.

---

## 🔎 Query Engine (Custom DSL)

A custom query language enables precise structural filtering.

Example queries:

```sql
type == "payment" AND data.amount > 500

data.user.id == "abc123"

type != "heartbeat" AND headers.userAgent matches "curl/.*"
```

Supported features:

* nested field access
* numeric comparisons
* regex operators
* boolean expressions

Filtering executes inside a **dedicated worker thread**.

---

## 🧬 Streaming JavaScript Interceptors

Transform events dynamically using custom JavaScript.

Example:

```javascript
function intercept(event) {
  if (event.type === "obfuscated_wrapper") {
    const payload = JSON.parse(event.data).hidden_payload;

    return {
      ...event,
      data: JSON.stringify(payload),
      type: "clean_payload"
    };
  }

  return event;
}
```

Interceptors run inside sandboxed worker environments to prevent blocking the UI thread.

---

## 🚨 Sliding-Window Pattern Detection

Define rules that monitor the event stream for anomalies.

Supported patterns include:

### Burst Detection

Trigger alerts when a threshold is exceeded within a time window.

Example:

```text
5 error events within 10 seconds
```

### Sequence Detection

Ensure expected workflows complete correctly.

Example sequence:

```text
request_start → db_write → response
```

Missing steps generate alerts.

---

## 🔗 Distributed Trace Waterfall

The system detects common tracing identifiers:

```text
traceId
correlationId
spanId
requestId
```

When a trace chain is detected, the **Trace Inspector** renders a waterfall visualization showing:

* event ordering
* service latency
* workflow duration

---

## 🎞 Mock Server & Replay

Record and replay real event sessions.

Features include:

* exporting `.sse-record` session files
* deterministic replay using original timing
* adjustable playback speeds
* reproducible debugging environments

This enables **incident reproduction without a live backend**.

---

## 🧠 Dynamic Schema Inference

Incoming JSON payloads are analyzed to infer structure automatically.

The system tracks:

* field names
* data types
* occurrence frequency
* nested object paths

This produces a **live schema representation** of the event stream.

---

## 💾 Cold Storage & Analytics

Older events are persisted to **IndexedDB**.

This provides:

* crash-resistant session history
* historical queries
* data export (JSON / CSV)

---

# 🛠 Installation

Requires **Node.js 18+**

Clone the repository:

```bash
git clone https://github.com/your-org/sse-observatory.git
cd sse-observatory
```

Install dependencies:

```bash
npm install
```

Start the development server:

```bash
npm run dev
```

Open the application:

```text
http://localhost:3001
```

---

# 🧪 Chaos Testing

The repository includes multiple local test servers for stress testing.

| Command                   | Purpose                                            |
| ------------------------- | -------------------------------------------------- |
| `npm run simple`          | Emits regular heartbeat events                     |
| `npm run chaos`           | Emits malformed payloads and connection drops      |
| `node test-servers/test-interceptor-server.js` | Generates wrapped payloads for interceptor testing |
| `node test-servers/test-pattern-server.js`     | Simulates burst error conditions                   |
| `node test-servers/test-multistream-server.js` | Produces correlated multi-service streams          |

These tests validate:

* reconnect logic
* worker isolation
* pattern detection
* multi-stream correlation

---

# 🚀 Deployment

The application can be deployed on platforms like **Vercel**.

A lightweight proxy layer allows monitoring external SSE endpoints without modifying their CORS configuration.

Deployment steps:

1. Push repository to GitHub
2. Import project into Vercel
3. Deploy using default Vite build settings

---

# 🗺 Roadmap

Planned improvements:

* WASM-powered query engine
* Protobuf decoding support
* WebSocket transport compatibility
* large-scale stream analytics

---

# 🤝 Contributing

Contributions are welcome.

Please open issues or submit pull requests for:

* bug fixes
* performance improvements
* feature proposals

---

# 📜 License

MIT License

---

<div align="center">

⭐ **If this project helped you debug a difficult event stream, consider starring the repository.**

Built for engineers who prefer **observability over guesswork.**

</div>
