/**
 * Time source for everything that measures. `now()` is monotonic (it never goes backwards and is unaffected by the
 * system clock being changed or a laptop sleeping), so every duration and gap in a capture is computed from it.
 * `epoch()` is wall-clock time and is only read once per capture, for display ("started at 10:42").
 *
 * It is injectable so analysis code can run on virtual time in tests and when replaying a capture.
 */
export interface Clock {
    /** Monotonic milliseconds from an arbitrary origin. */
    now(): number
    /** Wall-clock milliseconds since the Unix epoch. */
    epoch(): number
}

export const performanceClock: Clock = {
    now: () => performance.now(),
    epoch: () => Date.now(),
}
