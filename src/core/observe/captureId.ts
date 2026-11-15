/**
 * An opaque identifier for one capture of one connection. It is random and carries no information: never derived from
 * the URL or token (the SharedWorker keys its connections by `url::token`, and that must never reach a capture).
 * crypto.randomUUID exists only in secure contexts, so fall back for plain-HTTP self-hosting.
 */
export function newCaptureId(): string {
    const c = (globalThis as { crypto?: Crypto }).crypto
    if (c?.randomUUID) return c.randomUUID()
    const bytes = new Uint8Array(16)
    if (c?.getRandomValues) c.getRandomValues(bytes)
    else for (let i = 0; i < bytes.length; i++) bytes[i] = Math.floor(Math.random() * 256)
    return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('')
}
