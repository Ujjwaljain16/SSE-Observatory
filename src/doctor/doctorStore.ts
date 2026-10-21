/**
 * Runs the diagnostics for every stream the observation registry holds, outside React, and hands React immutable
 * views through useSyncExternalStore. This file is small on purpose: the rules live in doctorSession.ts, which is
 * loaded the first time a stream has records, so a page that never connects never downloads them.
 *
 * Work is bounded: registry changes are folded into at most one sync per SYNC_MS, and time-based findings (silences)
 * advance once a second. Nothing runs while nobody subscribes.
 */

import { observationRegistry, type ObservationRegistry } from './observationRegistry'
import type { DoctorSession, DoctorView } from './doctorSession'

const SYNC_MS = 250
const TICK_MS = 1000
/** Hidden for longer than this and the silence since says nothing about the stream. */
const HIDDEN_DISCONTINUITY_MS = 2000

export interface DoctorStoreOptions {
    registry?: ObservationRegistry
    /** Monotonic page time in milliseconds. */
    now?: () => number
    isHidden?: () => boolean
    loadEngine?: () => Promise<typeof import('./doctorSession')>
}

export type DoctorViews = ReadonlyMap<string, DoctorView>

export class DoctorStore {
    private readonly registry: ObservationRegistry
    private readonly now: () => number
    private readonly isHidden: () => boolean
    private readonly loadEngine: () => Promise<typeof import('./doctorSession')>
    private engine: typeof import('./doctorSession') | null = null
    private loading: Promise<void> | null = null
    private readonly sessions = new Map<string, DoctorSession>()
    private views: DoctorViews = new Map()
    private readonly listeners = new Set<() => void>()
    private unsubscribeRegistry: (() => void) | null = null
    private syncTimer: ReturnType<typeof setTimeout> | null = null
    private tickTimer: ReturnType<typeof setInterval> | null = null
    private lastSync = -Infinity
    private hiddenAt: number | null = null
    private onVisibility: (() => void) | null = null

    constructor(options: DoctorStoreOptions = {}) {
        this.registry = options.registry ?? observationRegistry
        this.now = options.now ?? (() => performance.now())
        this.isHidden = options.isHidden ?? (() => typeof document !== 'undefined' && document.hidden)
        this.loadEngine = options.loadEngine ?? (() => import('./doctorSession'))
    }

    subscribe = (listener: () => void): (() => void) => {
        this.listeners.add(listener)
        if (this.listeners.size === 1) this.start()
        return () => {
            this.listeners.delete(listener)
            if (this.listeners.size === 0) this.stop()
        }
    }

    getViews = (): DoctorViews => this.views

    /** Bring everything up to date now, including silences that are still going on (used by tests). */
    async refresh(): Promise<void> {
        await this.sync()
        this.tick()
    }

    private start(): void {
        this.unsubscribeRegistry = this.registry.subscribe(() => this.schedule())
        this.tickTimer = setInterval(() => this.tick(), TICK_MS)
        if (typeof document !== 'undefined') {
            this.onVisibility = () => this.visibilityChanged()
            document.addEventListener('visibilitychange', this.onVisibility)
        }
        this.schedule()
    }

    private stop(): void {
        this.unsubscribeRegistry?.()
        this.unsubscribeRegistry = null
        if (this.tickTimer) clearInterval(this.tickTimer)
        if (this.syncTimer) clearTimeout(this.syncTimer)
        this.tickTimer = this.syncTimer = null
        if (this.onVisibility && typeof document !== 'undefined') document.removeEventListener('visibilitychange', this.onVisibility)
        this.onVisibility = null
        this.sessions.clear()
        this.views = new Map()
    }

    private schedule(): void {
        if (this.syncTimer) return
        const wait = Math.max(0, SYNC_MS - (this.now() - this.lastSync))
        this.syncTimer = setTimeout(() => { this.syncTimer = null; void this.sync() }, wait)
    }

    private async ensureEngine(): Promise<boolean> {
        if (this.engine) return true
        if (this.registry.ids().length === 0) return false
        this.loading ??= this.loadEngine().then((m) => { this.engine = m }).catch((err: unknown) => {
            console.error('[doctor] could not load the diagnostics:', err)
            this.loading = null
        })
        await this.loading
        return this.engine !== null
    }

    private async sync(): Promise<void> {
        if (!(await this.ensureEngine()) || !this.engine) return
        const t = this.now()
        this.lastSync = t
        const ids = new Set(this.registry.ids())
        for (const id of [...this.sessions.keys()]) if (!ids.has(id)) this.sessions.delete(id)
        for (const id of ids) {
            if (!this.sessions.has(id)) this.sessions.set(id, new this.engine.DoctorSession(id))
            const entry = this.registry.get(id)
            if (entry) this.sessions.get(id)!.sync(entry, t, this.registry.pageElapsed(id))
        }
        this.publish(t)
    }

    private tick(): void {
        if (!this.engine || this.sessions.size === 0 || this.isHidden()) return
        const t = this.now()
        for (const session of this.sessions.values()) session.tick(t)
        this.publish(t)
    }

    private visibilityChanged(): void {
        if (this.isHidden()) { this.hiddenAt = this.now(); return }
        const hidden = this.hiddenAt
        this.hiddenAt = null
        if (hidden === null || !this.engine) return
        const t = this.now()
        const gap = t - hidden
        if (gap >= HIDDEN_DISCONTINUITY_MS) {
            for (const session of this.sessions.values()) session.discontinuity(t, gap, 'the tab was hidden')
        }
        this.publish(t)
    }

    private publish(t: number): void {
        const next = new Map<string, DoctorView>()
        for (const [id, session] of this.sessions) {
            const entry = this.registry.get(id)
            if (entry) next.set(id, session.view(t, entry))
        }
        this.views = next
        for (const listener of this.listeners) listener()
    }
}

export const doctorStore = new DoctorStore()
