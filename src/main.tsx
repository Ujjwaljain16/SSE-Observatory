import * as Sentry from '@sentry/react'

Sentry.init({
  dsn: "https://examplePublicKey@o0.ingest.sentry.io/0",
  integrations: [
    Sentry.browserTracingIntegration(),
    Sentry.replayIntegration(),
  ],
  tracesSampleRate: 0.05,
  replaysSessionSampleRate: 0.01,
  replaysOnErrorSampleRate: 1.0,
})

import './index.css'
import React from 'react'
import ReactDOM from 'react-dom/client'
import App from './App.tsx'

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <Sentry.ErrorBoundary fallback={<p>An error has occurred in the UI.</p>}>
      <App />
    </Sentry.ErrorBoundary>
  </React.StrictMode>,
)
