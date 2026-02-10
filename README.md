<div align="center">

# 🎯 SSE-Observatory

### Real-time Server-Sent Events Debugging & Monitoring Tool

[![React](https://img.shields.io/badge/React-18.2.0-61DAFB?style=for-the-badge&logo=react&logoColor=white)](https://react.dev/)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.9.3-3178C6?style=for-the-badge&logo=typescript&logoColor=white)](https://www.typescriptlang.org/)
[![Tailwind CSS](https://img.shields.io/badge/Tailwind-3.4.1-06B6D4?style=for-the-badge&logo=tailwindcss&logoColor=white)](https://tailwindcss.com/)
[![Vite](https://img.shields.io/badge/Vite-5.0.8-646CFF?style=for-the-badge&logo=vite&logoColor=white)](https://vitejs.dev/)

*A developer tool born from frustration, built for productivity.*

---

[Features](#-features) • [Installation](#-installation) • [Usage](#-usage) • [The Story](#-the-story) • [Contributing](#-contributing)

</div>

---

## 📖 The Story

### Why I Built This

It was 2 AM. I was debugging a payment webhook system that used Server-Sent Events to push real-time transaction updates. The events were firing—I could see them in the network tab—but something was wrong. Events were being dropped, timestamps didn't match, and I had no way to filter through the hundreds of events flooding in.

**I needed to see what was actually happening.**

I tried browser DevTools, but the Network tab doesn't let you filter SSE events by content. I tried logging to console, but when you're getting 50+ events per second, good luck finding anything. I tried third-party tools, but they either didn't handle authentication or couldn't deal with CORS.

So I built this.

### What Started as a Quick Script...

What began as a hacky Node.js script to proxy SSE connections evolved into something I now use daily. Every time I work with:
- **Real-time dashboards** that need event verification
- **Webhook systems** where I need to see exactly what's being pushed
- **Chat applications** with live message debugging
- **IoT data streams** from various sensors
- **Stock/crypto tickers** and financial data feeds

I open this tool.

### The Philosophy

**Developers need clarity, not complexity.**

This tool does one thing exceptionally well: it shows you exactly what's coming through your SSE connection, lets you filter it however you want, and gets out of your way. No bloat, no learning curve, no enterprise pricing.

---

## ✨ Features

### 🔌 Core Capabilities
| Feature | Description |
|---------|-------------|
| **One-Click Connect** | Paste a URL, click connect. That's it. |
| **Bearer Auth Support** | Token-based authentication just works. |
| **Live Event Stream** | Watch events flow in real-time with premium color-coded types. |
| **Profile Saving** | Save your frequent connections for quick access. |
| **Dark/Light Mode** | Easy on the eyes, day or night. |
| **Auto-Reconnect** | Smart reconnection logic handles network drops gracefully. |

### 🔍 Power-User Filtering (New in v2.0)
| Feature | Description |
|---------|-------------|
| **Smart Filtering** | Filter by ANY JSON field, including nested paths (e.g., `data.user.id`). |
| **Regex Support** | Use standard regex patterns for complex text matching. |
| **Numeric Logic** | Filter values with operators: `>`, `<`, `>=`, `<=`, `==`, `!=` (e.g., `latency > 500`). |
| **Query Language** | Write SQL-like queries: `type == "error" AND data.severity == "high"`. |
| **Global Search** | Instant text search across all event types and payloads. |

### ⏳ Time-Travel Debugging (New in v2.0)
| Feature | Description |
|---------|-------------|
| **Event Timeline** | Visual scrubber showing event density over time. |
| **Time Travel** | Pause the stream and replay history to spot transient bugs. |
| **Playback Controls** | Step forward/backward frame-by-frame or replay at 1x/2x/4x speed. |
| **Ring Buffer** | Efficiently manages up to 1,000 events without browser lag. |
| **Live vs. Replay** | Seamlessly toggle between live real-time view and historical inspection. |

---

## 🚀 Installation

### Prerequisites

- **Node.js** 18+ ([Download](https://nodejs.org))
- **npm** or **yarn**

### Quick Start

```bash
# Clone the repository
git clone https://github.com/yourusername/sse-observatory.git
cd sse-observatory

# Install dependencies
npm install

# Start the development server
npm run dev
```

The app opens automatically at `http://localhost:3000`

### Environment Configuration (Optional)

Create a `.env` file to customize the port:

```env
VITE_PORT=3001
```

---

## 📖 Usage

### Basic Connection

1. **Enter your SSE endpoint URL**
   ```
   https://api.yourservice.com/events/stream
   ```

2. **Add authentication (if needed)**
   - Paste your Bearer token
   - It's sent as: `Authorization: Bearer <your-token>`

3. **Click Connect** and watch the events flow!

### Advanced Filtering

The filtering system is designed for power users:

- **Regex**: Toggle `.*` mode to use regex patterns (e.g., `^user_\d+`).
- **Logic**: Use numeric comparisons like `data.score > 100`.
- **Query Mode**: Use the query bar for complex logic:
  ```sql
  type == "update" AND (data.status == "failed" OR data.latency > 1000)
  ```

### Time-Travel Debugging

1. **Pause** the stream to stop the live feed (events continue buffering in background).
2. **Scrub** the timeline at the bottom to jump to past events.
3. **Step** through events one by one to analyze state changes.
4. **Replay** the session at 1x, 2x, or 4x speed to visualize the flow of events as they happened.
5. Click **GO LIVE** to return to the real-time stream.

---

## 🏗️ Architecture

### How It Works

```
┌─────────────────────────────────────────────────────────────────┐
│                        Your Browser                              │
├─────────────────────────────────────────────────────────────────┤
│                                                                  │
│   ┌─────────────┐     ┌─────────────┐     ┌─────────────────┐   │
│   │   React UI  │────▶│  EventSource │────▶│  Vite Proxy     │   │
│   │             │◀────│  API        │◀────│  /api/sse       │   │
│   └─────────────┘     └─────────────┘     └────────┬────────┘   │
│                                                      │           │
│                                                      │           │
│  ┌──────────────┐                          ┌─────────▼────────┐  │
│  │ Time-Travel  │                          │   Your SSE       │  │
│  │ Ring Buffer  │                          │   Endpoint       │  │
│  └──────────────┘                          │   (Any Origin)   │  │
│                                            └──────────────────┘  │
└─────────────────────────────────────────────────────────────────┘
```

### Why a Proxy?

Browsers block cross-origin SSE connections (CORS) by default. SSE-Observatory includes a built-in lightweight proxy (via Vite) that:
1. Proxies requests server-side to bypass CORS.
2. Injects headers (like Auth tokens) securely.
3. Streams responses back to the client instantly.

---

## 🛠️ Development

### Available Scripts

```bash
# Development with hot reload
npm run dev

# Type checking
npx tsc --noEmit

# Production build
npm run build

# Preview production build
npm run preview

# Lint code
npm run lint
```

### Project Structure

```
src/
├── App.tsx              # Main application orchestrator
├── components/          # UI components
│   ├── EventTimeline.tsx # Canvas-based timeline visualization
│   ├── PlaybackControls.tsx # Time-travel controls
│   ├── CustomFilters.tsx # Advanced filtering UI
│   ├── QueryInput.tsx    # SQL-like query parser UI
│   └── ...
├── hooks/               # Custom React hooks
│   ├── useEventStream.ts # SSE connection & Ring Buffer logic
│   ├── usePlayback.ts    # Replay & Time-travel state machine
│   ├── useQueryParser.ts # AST parser for query language
│   └── ...
├── types/               # TypeScript interfaces
└── utils/               # Helper functions
```

---

## 🤝 Contributing

Contributions make open source amazing! Here's how to help:

1. Fork the repository
2. Create a feature branch (`git checkout -b feature/amazing-feature`)
3. Commit your changes (`git commit -m 'Add amazing feature'`)
4. Push to the branch (`git push origin feature/amazing-feature`)
5. Open a Pull Request

---

## 📜 License

This project is open source and available under the [MIT License](LICENSE).

---

<div align="center">

**Built with ☕ and frustration**

*If this tool saved you time, consider starring the repo!*

⭐

</div>
