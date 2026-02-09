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

<div align="center">

| Feature | Description |
|---------|-------------|
| 🔌 **One-Click Connect** | Paste a URL, click connect. That's it. |
| 🔐 **Bearer Auth Support** | Token-based authentication just works. |
| 🎨 **Live Event Stream** | Watch events flow in real-time with color-coded types. |
| 🔍 **Smart Filtering** | Filter by ANY JSON field, including nested paths. |
| 💾 **Profile Saving** | Save your frequent connections for quick access. |
| 🌓 **Dark/Light Mode** | Easy on the eyes, day or night. |
| 📋 **One-Click Copy** | Copy any event data instantly. |
| ⏱️ **Connection Timer** | Know exactly how long you've been connected. |
| 📊 **Event Statistics** | Track event counts and filter matches. |
| 🔄 **Auto-Reconnect** | Handles connection drops gracefully. |
| 📤 **Export Events** | Download captured events as JSON or CSV. |
| 🔎 **Event Search** | Search across all event data in real-time. |

</div>

---

## 🚀 Installation

### Prerequisites

- **Node.js** 18+ ([Download](https://nodejs.org))
- **npm** or **yarn**

### Quick Start

```bash
# Clone the repository
git clone https://github.com/yourusername/sse-monitor.git
cd sse-monitor

# Install dependencies
npm install

# Start the development server
npm run dev
```

The app opens automatically at `http://localhost:3000`

### Environment Configuration (Optional)

Create a `.env` file to customize the port:

```env
VITE_PORT=5003
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

### Filtering Events

The real power is in filtering. Add filters for any JSON field:

```
type                    → Filter by event type
data.userId             → Filter by nested user ID
payload.status          → Filter by payload status
meta.environment        → Filter by environment tag
```

**How it works:**
- Add a filter field → See all unique values found
- Click values to toggle them → Only matching events show
- Multiple filters combine with AND logic

### Saving Profiles

For endpoints you use frequently:
1. Enter the URL and token
2. Type a profile name
3. Click 💾 Save

Profiles persist in your browser—switch between them with one click.

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
└──────────────────────────────────────────────────────┼───────────┘
                                                       │
                                                       ▼
                                            ┌─────────────────┐
                                            │  Your SSE       │
                                            │  Endpoint       │
                                            │  (any domain)   │
                                            └─────────────────┘
```

### Why a Proxy?

Browsers block cross-origin SSE connections (CORS). Instead of asking you to configure your server, SSE Monitor includes a built-in proxy that:

1. Receives your target URL
2. Makes the request server-side (no CORS!)
3. Pipes the SSE stream back to your browser
4. Injects your Bearer token if provided

**Zero configuration on your SSE server required.**

### Tech Stack Choices

| Choice | Why |
|--------|-----|
| **React 18** | Hooks + concurrent rendering = smooth event streaming |
| **TypeScript** | Type safety prevents runtime surprises |
| **Vite** | Instant HMR, built-in dev server for proxy logic |
| **Tailwind CSS** | Rapid UI iteration, tiny production bundle |
| **EventSource API** | Native browser SSE handling, battle-tested |

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
├── App.tsx              # Main app orchestrator
├── components/          # UI components
│   ├── Header.tsx       # App header + theme toggle
│   ├── ProfileTabs.tsx  # Saved connection profiles
│   ├── ConnectionPanel.tsx  # URL/token inputs
│   ├── CustomFilters.tsx    # Dynamic filtering UI
│   ├── EventsList.tsx       # Event stream display
│   └── ...
├── hooks/              # Custom React hooks
│   ├── useTheme.ts     # Dark/light mode
│   ├── useProfiles.ts  # Profile CRUD
│   └── useCustomFilters.ts  # Filter logic
├── types/              # TypeScript interfaces
└── utils/              # Helper functions
```

---

## 🤝 Contributing

Contributions make open source amazing! Here's how to help:

### Bug Reports

Found a bug? [Open an issue](../../issues/new) with:
- Steps to reproduce
- Expected vs actual behavior
- Browser/OS information

### Feature Requests

Have an idea? [Start a discussion](../../discussions) first—let's design it together!

### Pull Requests

1. Fork the repository
2. Create a feature branch (`git checkout -b feature/amazing-feature`)
3. Commit your changes (`git commit -m 'Add amazing feature'`)
4. Push to the branch (`git push origin feature/amazing-feature`)
5. Open a Pull Request

---

## 📜 License

This project is open source and available under the [MIT License](LICENSE).

---

## 💭 Final Thoughts

This tool exists because debugging real-time systems shouldn't require a PhD. Whether you're building the next big fintech platform or just trying to figure out why your chat messages are duplicating, I hope this helps.

**Happy debugging!** 🎯

---

<div align="center">

**Built with ☕ and frustration**

*If this tool saved you time, consider starring the repo!*

⭐

</div>
