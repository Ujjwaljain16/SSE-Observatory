import zlib from 'node:zlib'
import type { LoggedConnection } from '../groundTruth'

/**
 * The server's log records what it wrote to the socket, which for a compressed stream is gzip, not events. A comparison with what a client
 * read (undici decodes the body before the parser sees it) is only meaningful in plain bytes, so a test turns the log into what the client was
 * given: the same writes, each one replaced by the plain bytes it completed.
 */

/** True when the connection's body is a gzip stream: it starts with the magic number 1f 8b (no event stream does). */
export function isGzipped(c: LoggedConnection): boolean {
    const first = c.writes.find((w) => w.bytes > 0)?.raw
    return first !== undefined && first.length >= 2 && first[0] === 0x1f && first[1] === 0x8b
}

/**
 * The connection with every write decoded. A sync flush ends the compressed block on a byte boundary, so everything written up to a flush can be
 * read before the stream is finished: the decoder is given all the wire bytes so far and the bytes that are new are that write's. A connection
 * that is not gzip is returned as it is.
 */
export function gunzipLog(c: LoggedConnection): LoggedConnection {
    if (!isGzipped(c)) return c
    let wire = Buffer.alloc(0)
    let seen = 0
    const writes = c.writes.map((w) => {
        wire = Buffer.concat([wire, Buffer.from(w.raw)])
        const plain = zlib.gunzipSync(wire, { finishFlush: zlib.constants.Z_SYNC_FLUSH })
        const piece = plain.subarray(seen)
        seen = plain.length
        return { ...w, bytes: piece.length, raw: Uint8Array.from(piece), text: piece.toString('utf8') }
    })
    return { ...c, writes }
}
