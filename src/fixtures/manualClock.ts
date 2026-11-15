/**
 * A stepped clock for the fixture server (plan A2).
 *
 * With `startFixtureServer({ clock: 'manual' })` (or `?clock=manual` on one request) `ctx.sleep(ms)` does not wait for real time: it
 * registers a sleeper against this virtual clock, and nothing is written until the test calls `server.advance(ms)`. `advance` releases
 * every sleeper that comes due, earliest first (ties in the order they were registered), and after each release waits until the script it
 * woke has written whatever it writes and gone back to sleep (or finished), then lets one macrotask turn pass so the socket has been
 * written to before the next sleeper runs. Frame order and write boundaries become the test's to control: no timing flake.
 *
 * What it does NOT control is the client: its own timers are real, and a loopback socket can still merge two writes into one read. So a
 * test written against this clock asserts on bytes and event ids, not on how many chunks they came in, unless it waits for the client to
 * have seen one write before it advances to the next. It is for protocol and ordering tests, not for the timing rules (those have virtual
 * time of their own in `captureBuilder`).
 */

interface Sleeper {
    at: number
    order: number
    resolve: (value: boolean) => void
}

/** What one request's script uses in place of `setTimeout`. */
export interface ClockSession {
    /** Sleeps `ms` of virtual time. Resolves false when the session has ended (the client left). */
    sleep(ms: number): Promise<boolean>
    /** The script has finished, or the client has gone: release every sleep it still has and stop counting it as running. Idempotent. */
    end(): void
}

/** The longest `advance` waits for a woken script to write and sleep again (the default). A script that waits on something else is a bug of that script. */
const QUIET_CEILING_MS = 5000

export class ManualClock {
    private t = 0
    private order = 0
    private readonly sleepers = new Set<Sleeper>()
    /** Scripts that are awake: started or woken, and not yet asleep again or finished. */
    private running = 0
    private waiting: Array<() => void> = []

    constructor(private readonly ceilingMs: number = QUIET_CEILING_MS) {}

    /** Virtual milliseconds since the clock was made. */
    get now(): number { return this.t }

    /** Sleeps that are registered and not yet released. */
    get pending(): number { return this.sleepers.size }

    /** Starts a session for one request. The script is counted as running until its first sleep, so `advance` right after a request waits for it. */
    session(): ClockSession {
        let awake = true
        let ended = false
        this.running++
        const park = (): void => {
            if (!awake) return
            awake = false
            this.running--
            this.notify()
        }
        const own = new Set<Sleeper>()
        const session: ClockSession = {
            sleep: (ms) => new Promise<boolean>((resolve) => {
                if (ended) { resolve(false); return }
                park()
                const sleeper: Sleeper = {
                    at: this.t + Math.max(0, Number.isFinite(ms) ? ms : 0), order: this.order++,
                    resolve: (value) => {
                        this.sleepers.delete(sleeper)
                        own.delete(sleeper)
                        // a sleep that is released for real wakes its script; one released because the client left does not
                        if (value) { awake = true; this.running++ }
                        resolve(value)
                    },
                }
                this.sleepers.add(sleeper)
                own.add(sleeper)
            }),
            end: () => {
                ended = true
                for (const sleeper of [...own]) sleeper.resolve(false)
                park()
            },
        }
        return session
    }

    /**
     * Moves the clock forward `ms`, releasing every sleep that falls due on the way. Sleeps a woken script registers inside the window are
     * released too, in order. Resolves when every script is asleep again, one macrotask turn after the last write.
     */
    async advance(ms: number): Promise<void> {
        if (!(ms >= 0) || !Number.isFinite(ms)) throw new Error(`advance needs a number of milliseconds of at least 0, got ${ms}`)
        const target = this.t + ms
        await this.quiet()
        for (;;) {
            let next: Sleeper | undefined
            for (const sleeper of this.sleepers) if (sleeper.at <= target && (!next || sleeper.at < next.at || (sleeper.at === next.at && sleeper.order < next.order))) next = sleeper
            if (!next) break
            this.t = Math.max(this.t, next.at)
            next.resolve(true)
            await this.quiet()
        }
        this.t = target
    }

    private notify(): void {
        if (this.running > 0) return
        const waiting = this.waiting
        this.waiting = []
        for (const wake of waiting) wake()
    }

    /** Waits until no script is awake, then one macrotask turn (so the socket has the bytes), and checks again. */
    private async quiet(): Promise<void> {
        const deadline = Date.now() + this.ceilingMs
        for (;;) {
            while (this.running > 0) {
                const left = deadline - Date.now()
                if (left <= 0) throw new Error(`a fixture script was still running ${this.ceilingMs} ms after the clock moved: it waits for something other than ctx.sleep`)
                await new Promise<void>((resolve) => {
                    const timer = setTimeout(resolve, left)
                    this.waiting.push(() => { clearTimeout(timer); resolve() })
                })
            }
            await new Promise<void>((resolve) => setImmediate(resolve))
            if (this.running === 0) return
        }
    }
}
