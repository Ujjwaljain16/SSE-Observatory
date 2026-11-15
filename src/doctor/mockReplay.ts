/**
 * Replays a capture through the app's own mock server, so a recorded problem can be watched again in the viewer and the
 * Doctor. The capture goes to this origin's `/api/mock/session` and the stream is the URL that comes back.
 */

export type MockReplay = { ok: true; url: string; sessionId: string; fidelity?: string } | { ok: false; error: string }

/** The path of a mock stream, so the app can tell a replay from a live stream. */
export const MOCK_STREAM_PATH = '/api/mock/stream'

export const isMockStreamUrl = (url: string): boolean => url.includes(MOCK_STREAM_PATH)

const NOT_ENABLED = 'The mock server is not enabled here. It is on in development and off on a public deployment unless it was switched on for it (ENABLE_MOCK_API=1).'

export async function startMockReplay(captureText: string, origin: string = window.location.origin): Promise<MockReplay> {
    let response: Response
    try {
        response = await fetch('/api/mock/session', { method: 'POST', headers: { 'Content-Type': 'application/x-ndjson' }, body: captureText })
    } catch {
        return { ok: false, error: 'The mock server could not be reached. Is the app running with its server?' }
    }
    let body: { sessionId?: unknown; error?: unknown; fidelity?: unknown } = {}
    try { body = (await response.json()) as typeof body } catch { /* a host that answers with a page, not JSON */ }
    if (!response.ok) {
        if (response.status === 404) return { ok: false, error: NOT_ENABLED }
        if (response.status === 429) return { ok: false, error: `${typeof body.error === 'string' ? body.error : 'Too many requests'}. Try again in a moment.` }
        return { ok: false, error: typeof body.error === 'string' ? body.error : `The mock server refused the capture (status ${response.status}).` }
    }
    if (typeof body.sessionId !== 'string') return { ok: false, error: 'The mock server answered without a session.' }
    // honorLastEventId: a reconnect resumes after the id it sends, as the original server did
    const url = `${origin}${MOCK_STREAM_PATH}?session=${encodeURIComponent(body.sessionId)}&honorLastEventId=1`
    return { ok: true, url, sessionId: body.sessionId, ...(typeof body.fidelity === 'string' ? { fidelity: body.fidelity } : {}) }
}
