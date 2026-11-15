// "Connection lost (HTTP 502). Retrying in 5s (attempt 2)…": the seconds are for the eyes. A screen reader is told the same
// thing once per attempt: if the seconds were part of what it reads, every change of the countdown would be read out again.
const RETRY = /^([\s\S]*?Retrying)( in \d+s)([\s\S]*)$/

export function RetryMessage({ message }: { message: string }) {
    const m = RETRY.exec(message)
    if (!m) return <>{message}</>
    return <>{m[1]}<span aria-hidden="true">{m[2]}</span>{m[3]}</>
}
