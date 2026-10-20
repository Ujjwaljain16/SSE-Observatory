/* eslint-disable @typescript-eslint/no-explicit-any */
// Types for lib/mock/capturePlan.js, so the CLI (TypeScript) can serve a capture without a second implementation.

export interface PlanStep { atMs: number; write: string | Buffer }

export interface ReplayPlan {
    steps: PlanStep[]
    mode: string
    error?: { status: number; message: string }
}

export interface PlanOptions {
    connection?: number
    speed?: number
    honorLastEventId?: boolean
    lastEventId?: string
    unknownId?: string
    skipIds?: string[]
    dropAfter?: number
}

export function looksLikeCapture(body: unknown): boolean
export function sessionFromCapture(body: unknown): { session?: any; error?: string }
export function planReplay(session: any, opts?: PlanOptions): ReplayPlan
export const END_BEHAVIOURS: string[]
