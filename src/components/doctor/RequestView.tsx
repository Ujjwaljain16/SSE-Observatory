import { useMemo } from 'react'
import type { Theme } from '../../types'
import type { DoctorView } from '../../doctor/doctorSession'
import { observationRegistry } from '../../doctor/observationRegistry'
import { inspectRequests, type RequestInfo } from '../../doctor/requestInspector'
import { fmtDuration } from './format'

interface Props {
    theme: Theme
    streamId: string
    view: DoctorView
    /** The heading level of the sections: one below the panel title. */
    sectionHeading?: SectionHeading
}

const MAX_ATTEMPTS = 20

function Stage({ label, ms, dark }: { label: string; ms: number | undefined; dark: boolean }) {
    return (
        <div className="flex gap-2">
            <dt className={dark ? 'text-slate-300' : 'text-slate-700'}>{label}</dt>
            <dd className="tabular-nums font-medium">{ms === undefined ? 'did not happen' : `after ${fmtDuration(ms)}`}</dd>
        </div>
    )
}

type SectionHeading = 'h3' | 'h4'

function Attempt({ r, dark, defaultOpen, H }: { r: RequestInfo; dark: boolean; defaultOpen: boolean; H: SectionHeading }) {
    const muted = dark ? 'text-slate-300' : 'text-slate-700'
    const strong = dark ? 'text-white' : 'text-slate-900'
    const ok = r.response !== undefined && r.response.status >= 200 && r.response.status < 300
    return (
        <details open={defaultOpen} className={`rounded-lg border ${dark ? 'border-slate-700' : 'border-slate-200'}`} data-testid="request-attempt">
            <summary className={`cursor-pointer px-3 py-2 text-sm font-medium ${strong}`}>
                Attempt {r.attempt + 1}: {r.response ? `${r.response.status}${ok ? '' : ' (not a success)'}` : 'no response'}
                <span className={`font-normal ${muted}`}> · {r.events.toLocaleString()} event{r.events === 1 ? '' : 's'} · {r.open ? 'still open' : (r.endReason ?? 'ended')}</span>
            </summary>
            <div className={`px-3 pb-3 space-y-3 text-sm ${strong}`}>
                <section aria-label="Request">
                    <H className="font-semibold mb-1">Request</H>
                    <p className="font-mono break-all" data-testid="request-line">{r.method} {r.url || '(no request recorded)'}</p>
                    {r.viaAppProxy && (
                        <p className={muted} data-testid="request-proxy-note">
                            This request went to the app's server proxy, which opened the stream you asked for, so the URL above is the proxy's. The <span className="font-mono">x-sse-*</span> headers below are the proxy's own report of that second request.
                        </p>
                    )}
                    <p className={muted}>
                        Header names sent: {r.requestHeaderNames.length > 0 ? <span className="font-mono">{r.requestHeaderNames.join(', ')}</span> : 'none recorded'}. Values are never recorded.
                        {' '}Last-Event-ID: <span className="font-mono">{r.sentLastEventId || (r.attempt === 0 ? 'none (first connection)' : 'none sent')}</span>.
                    </p>
                </section>

                <section aria-label="Response">
                    <H className="font-semibold mb-1">Response</H>
                    {r.response ? (
                        <>
                            <p>
                                Status <span className="font-mono font-medium">{r.response.status}</span>, content type <span className="font-mono">{r.response.contentType || 'none'}</span>
                                {r.response.redirected ? ', after a redirect' : ''}.
                            </p>
                            {r.response.headers.length > 0 ? (
                                <table className="mt-1 w-full">
                                    <caption className="sr-only">Response headers the Doctor keeps</caption>
                                    <thead><tr className={`text-left ${muted}`}><th scope="col" className="pr-3">Header</th><th scope="col">Value</th></tr></thead>
                                    <tbody>
                                        {r.response.headers.map(([name, value]) => (
                                            <tr key={name} className={`border-t ${dark ? 'border-slate-700' : 'border-slate-200'}`}>
                                                <th scope="row" className="pr-3 py-0.5 text-left font-mono font-medium">{name}</th>
                                                <td className="py-0.5 font-mono break-all">{value}</td>
                                            </tr>
                                        ))}
                                    </tbody>
                                </table>
                            ) : (
                                <p className={muted}>No headers could be read. A cross-origin response only shows the headers its server exposes with CORS.</p>
                            )}
                        </>
                    ) : (
                        <p className={muted}>No response arrived on this attempt.</p>
                    )}
                </section>

                <section aria-label="Timing">
                    <H className="font-semibold mb-1">Timing</H>
                    <dl className="grid gap-x-6 gap-y-0.5 sm:grid-cols-2">
                        <Stage label="Response headers" ms={r.timing.headersMs} dark={dark} />
                        <Stage label="First bytes" ms={r.timing.firstByteMs} dark={dark} />
                        <Stage label="First event" ms={r.timing.firstEventMs} dark={dark} />
                        <div className="flex gap-2"><dt className={muted}>Lasted</dt><dd className="tabular-nums font-medium">{fmtDuration(r.timing.totalMs)}{r.open ? ' so far' : ''}</dd></div>
                    </dl>
                    <p className={`mt-1 ${muted}`}>
                        {r.chunks.toLocaleString()} read{r.chunks === 1 ? '' : 's'}, {r.bytes.toLocaleString()} bytes.
                        {r.serverRetryMs !== undefined ? ` The server asked for a ${fmtDuration(r.serverRetryMs)} wait before reconnecting.` : ''}
                    </p>
                </section>
            </div>
        </details>
    )
}

export default function RequestView({ theme, streamId, view, sectionHeading = 'h3' }: Props) {
    const dark = theme === 'dark'
    const muted = dark ? 'text-slate-300' : 'text-slate-700'
    // Rebuilt when the recording changes (the record count says so), not on every tick.
    const attempts = useMemo(
        () => inspectRequests(observationRegistry.get(streamId)?.store.snapshot() ?? [], view.nowT),
        [streamId, view.health.capture.records, view.nowT], // eslint-disable-line react-hooks/exhaustive-deps -- nowT moves the open attempt's length
    )
    if (attempts.length === 0) {
        return <p className={`text-sm ${muted}`} data-testid="doctor-request">Nothing recorded yet. Each request appears here once the stream starts.</p>
    }
    const shown = attempts.slice(-MAX_ATTEMPTS).reverse() // newest first
    return (
        <section aria-label="Request inspector" className="space-y-3" data-testid="doctor-request">
            <p className={`text-sm ${muted}`}>
                What was asked and what came back, for each connection attempt, newest first. Only the response headers that explain buffering, caching
                and proxy behaviour are kept; request header values are never recorded, only their names.
            </p>
            {attempts.length > shown.length && <p className={`text-sm ${muted}`}>Showing the latest {shown.length} of {attempts.length} attempts.</p>}
            <div className="space-y-2">
                {shown.map((r, i) => <Attempt key={r.conn} r={r} dark={dark} defaultOpen={i === 0} H={sectionHeading} />)}
            </div>
        </section>
    )
}
