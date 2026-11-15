/** Base64 for wire bytes, with no dependency on btoa/Buffer (core must run in a browser worker and in Node alike). */

const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'
const LOOKUP = new Int16Array(128).fill(-1)
for (let i = 0; i < ALPHABET.length; i++) LOOKUP[ALPHABET.charCodeAt(i)] = i

export function bytesToBase64(bytes: Uint8Array): string {
    let out = ''
    let i = 0
    for (; i + 2 < bytes.length; i += 3) {
        const n = (bytes[i]! << 16) | (bytes[i + 1]! << 8) | bytes[i + 2]!
        out += ALPHABET[(n >> 18) & 63]! + ALPHABET[(n >> 12) & 63]! + ALPHABET[(n >> 6) & 63]! + ALPHABET[n & 63]!
    }
    const rest = bytes.length - i
    if (rest === 1) {
        const n = bytes[i]! << 16
        out += ALPHABET[(n >> 18) & 63]! + ALPHABET[(n >> 12) & 63]! + '=='
    } else if (rest === 2) {
        const n = (bytes[i]! << 16) | (bytes[i + 1]! << 8)
        out += ALPHABET[(n >> 18) & 63]! + ALPHABET[(n >> 12) & 63]! + ALPHABET[(n >> 6) & 63]! + '='
    }
    return out
}

export function base64ToBytes(text: string): Uint8Array {
    const clean = text.replace(/=+$/, '')
    const out = new Uint8Array(Math.floor((clean.length * 3) / 4))
    let buffer = 0
    let bits = 0
    let w = 0
    for (let i = 0; i < clean.length; i++) {
        const code = clean.charCodeAt(i)
        const v = code < 128 ? LOOKUP[code]! : -1
        if (v < 0) throw new Error(`not Base64: unexpected character at ${i}`)
        buffer = (buffer << 6) | v
        bits += 6
        if (bits >= 8) {
            bits -= 8
            out[w++] = (buffer >> bits) & 0xff
        }
    }
    return out.subarray(0, w)
}
