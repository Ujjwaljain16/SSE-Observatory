import type http from 'node:http'
import type { StreamProfile } from '../core/diagnostics/thresholds'

export interface FixtureRoute {
    id: string
    path: string
    title: string
    description: string
    /** Finding keys (or key prefixes) the diagnostics must report for this stream. */
    expectedFindings: string[]
    /** Finding keys or prefixes that must NOT appear. `'*'` means no finding at all (a healthy twin). */
    forbiddenFindings: string[]
    /** The route that behaves correctly, to compare against. */
    healthyTwin: string | null
    /** Which fixture family of the plan this belongs to (F01..F08, H01..H04). */
    family: string
    /** Events sent before a route finishes when the request gives no ?n=. Default 5. */
    defaultN?: number
    /** The stream profile a user would declare for this route (for example its sequence contract); the checks run with it. */
    profile?: StreamProfile
}

const FINDINGS_NEVER_ON_HEALTHY = ['*']

export { FINDINGS_NEVER_ON_HEALTHY }

export interface Ctx {
    /** The raw Last-Event-ID request header, '' when absent. */
    lastEventId: string
    req: http.IncomingMessage
    res: http.ServerResponse
    query: URLSearchParams
    scale: number
    /** Events to send before finishing. */
    n: number
    /** Index of the first event to send (from Last-Event-ID). */
    from: number
    write(chunk: string | Uint8Array): void
    /** Waits `ms` x scale. Resolves false when the client has gone. */
    sleep(ms: number): Promise<boolean>
    closed(): boolean
}

export type Script = (ctx: Ctx) => Promise<void>

export const STREAM_HEADERS = { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-cache', 'X-Accel-Buffering': 'no', Connection: 'keep-alive' }

export const numericId = (i: number) => String(i + 1)
export const uuidId = (i: number) => `00000000-0000-4000-8000-${(i + 1).toString(16).padStart(12, '0')}`

export const frame = (id: string, name: string, data: string, eol = '\n') =>
    `id: ${id}${eol}${name === 'message' ? '' : `event: ${name}${eol}`}data: ${data}${eol}${eol}`

/** Events sent one after another at a fixed interval, each carrying an id. */
export function steady(idOf: (i: number) => string, intervalMs: number): Script {
    return async (ctx) => {
        for (let i = ctx.from; i < ctx.n; i++) {
            if (!(await ctx.sleep(intervalMs))) return
            ctx.write(frame(idOf(i), 'tick', JSON.stringify({ n: i + 1 })))
        }
        ctx.write('event: end\ndata: done\n\n')
    }
}

export const lead = (ctx: Ctx, n: number, intervalMs: number) => (async () => {
    for (let i = ctx.from; i < n; i++) {
        if (!(await ctx.sleep(intervalMs))) return false
        ctx.write(frame(numericId(i), 'tick', JSON.stringify({ n: i + 1 })))
    }
    return true
})()


/** A group of fixture routes and the scripts that serve them. Families live in their own files so they can be added independently. */
export interface FixtureFamily {
    routes: FixtureRoute[]
    scripts: Record<string, Script>
}
