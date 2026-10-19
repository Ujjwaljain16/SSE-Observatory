import * as Sentry from '@sentry/react'

// Telemetry is opt-in: nothing is initialised unless a DSN is provided at build time.
// Session replay is intentionally not enabled — this tool displays tokens and event payloads.
const sentryDsn = import.meta.env.VITE_SENTRY_DSN
if (sentryDsn) {
  Sentry.init({
    dsn: sentryDsn,
    integrations: [Sentry.browserTracingIntegration()],
    tracesSampleRate: 0.05,
  })
}

import './index.css'
import { initialTheme } from './hooks/useTheme'
import React from 'react'
import ReactDOM from 'react-dom/client'
import App from './App.tsx'

// Apply the saved theme before the first paint so there is no light/dark flash.
document.documentElement.classList.toggle('dark', initialTheme() === 'dark')

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <Sentry.ErrorBoundary fallback={<p>An error has occurred in the UI.</p>}>
      <App />
    </Sentry.ErrorBoundary>
  </React.StrictMode>,
)
