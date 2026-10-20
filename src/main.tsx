import './index.css'
import { initialTheme } from './hooks/useTheme'
import React from 'react'
import ReactDOM from 'react-dom/client'
import App from './App.tsx'
import { ErrorBoundary } from './components/ErrorBoundary'
import { initTelemetry } from './utils/telemetry'

initTelemetry(import.meta.env.VITE_SENTRY_DSN)

// Apply the saved theme before the first paint so there is no light/dark flash.
document.documentElement.classList.toggle('dark', initialTheme() === 'dark')

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <ErrorBoundary>
      <App />
    </ErrorBoundary>
  </React.StrictMode>,
)
