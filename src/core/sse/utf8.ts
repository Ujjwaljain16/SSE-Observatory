/** UTF-8 byte length of a string without allocating (a lone surrogate counts as the 3 bytes of U+FFFD, like TextEncoder). */
export function utf8Length(text: string): number {
    let bytes = 0
    for (let i = 0; i < text.length; i++) {
        const c = text.charCodeAt(i)
        if (c < 0x80) bytes += 1
        else if (c < 0x800) bytes += 2
        else if (c >= 0xd800 && c <= 0xdbff && i + 1 < text.length && (text.charCodeAt(i + 1) & 0xfc00) === 0xdc00) { bytes += 4; i++ }
        else bytes += 3
    }
    return bytes
}
