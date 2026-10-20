import { Component, type ErrorInfo, type ReactNode } from 'react'
import { reportError } from '../utils/telemetry'

interface Props { children: ReactNode }
interface State { failed: boolean }

/** Last line of defence: a render error shows a message with a reload button instead of a blank page. */
export class ErrorBoundary extends Component<Props, State> {
    override state: State = { failed: false }

    static getDerivedStateFromError(): State {
        return { failed: true }
    }

    override componentDidCatch(error: Error, info: ErrorInfo) {
        console.error('[ErrorBoundary]', error)
        reportError(error, info.componentStack)
    }

    override render() {
        if (!this.state.failed) return this.props.children
        return (
            <div role="alert" className="min-h-screen flex flex-col items-center justify-center gap-4 p-6 text-center bg-slate-900 text-slate-100">
                <p className="text-lg font-semibold">An error has occurred in the UI.</p>
                <button
                    onClick={() => window.location.reload()}
                    className="px-4 py-2 rounded-lg bg-blue-600 hover:bg-blue-500 text-white text-sm font-semibold"
                >
                    Reload
                </button>
            </div>
        )
    }
}
