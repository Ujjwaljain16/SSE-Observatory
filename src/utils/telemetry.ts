// Telemetry is opt-in: nothing is downloaded or initialised unless a DSN is provided at build time.
// Session replay is intentionally not enabled: this tool displays tokens and event payloads.

type SentryModule = typeof import('@sentry/react')

let sentry: SentryModule | null = null
const pending: Array<{ error: unknown; componentStack?: string | null | undefined }> = []

export function initTelemetry(dsn: string | undefined): void {
    if (!dsn) return
    void import('@sentry/react')
        .then((mod) => {
            mod.init({ dsn, integrations: [mod.browserTracingIntegration()], tracesSampleRate: 0.05 })
            sentry = mod
            for (const p of pending.splice(0)) report(p.error, p.componentStack)
        })
        .catch(() => { /* telemetry must never break the app */ })
}

/** Sends an error to Sentry when telemetry is enabled (queued until the SDK has loaded). */
export function reportError(error: unknown, componentStack?: string | null): void {
    if (!sentry) {
        if (import.meta.env.VITE_SENTRY_DSN && pending.length < 20) pending.push({ error, componentStack })
        return
    }
    report(error, componentStack)
}

function report(error: unknown, componentStack?: string | null) {
    sentry?.captureException(error, componentStack ? { contexts: { react: { componentStack } } } : undefined)
}
