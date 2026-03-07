# Getting Started

SSE Observatory is a high-performance observability tool built to inspect raw Server-Sent Event (SSE) streams in real time. It runs entirely in your browser using a combination of Web Workers, a SharedWorker, and IndexedDB to deliver a backend-free analytics experience.

## Installation 

The tool is distributed as a Vite/React SPA. It requires **Node.js 18+**.

```sh
git clone https://github.com/Ujjwaljain16/SSE-Observatory.git
cd sse-observatory
npm install
npm run dev
```

Visit `http://localhost:3001` to view the Observatory.

## Connecting to a Stream

1. **Enter Endpoint:** Paste the absolute URL of the SSE stream into the **Connection Panel** on the left sidebar.
2. **Authentication:** If the endpoint requires bearer authentication, paste the token into the auth input field. It will automatically attach an `Authorization: Bearer <token>` header to the stream.
3. **Connect:** Click **Connect**. 

The Global Timeline will instantly populate as raw Byteframes begin processing.

## The Testing Suite

To familiarize yourself with the platform, we recommend connecting the Observatory to one of the provided test servers instead of a production endpoint. 

Open a separate terminal window and run:

- `npm run simple` (Clean Heartbeats)
- `npm run chaos` (Simulated Connection Droppages / Latency Issues)

Navigate the UI to watch how the generic Ring Buffer ingests, parses, and formats the outputs.
