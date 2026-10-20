/**
 * A curl command that repeats the request of a capture. Header values and query values are never written: a capture
 * may be shared, and a command copied out of a report must not carry a token. Each one becomes an environment variable
 * named after the header or parameter, which the person running the command sets themselves.
 */

import type { RedactedCapture } from '../redacted'
import { ofKind } from './records'

export type CurlShell = 'posix' | 'powershell'

export interface CurlOptions { shell?: CurlShell | undefined }

/** Part of a command word: text written as it is, or a reference to an environment variable. */
type Piece = { lit: string } | { env: string }

const lit = (text: string): Piece => ({ lit: text })
const env = (name: string): Piece => ({ env: name })

/** `Authorization` -> `STREAM_AUTHORIZATION`, `x-api-key` -> `STREAM_X_API_KEY`. Always a valid variable name. */
export function envNameFor(name: string): string {
    const body = name.toUpperCase().replace(/[^A-Z0-9]+/g, '_').replace(/^_+|_+$/g, '')
    return `STREAM_${body || 'VALUE'}`
}

const POSIX_DQ_SPECIAL = /[\\"$`]/g
const PS_SQ_QUOTES = /['\u2018\u2019\u201a\u201b]/g
const PS_DQ_SPECIAL = /[`"$\u201c\u201d\u201e]/g

function posixWord(pieces: Piece[]): string {
    if (pieces.every((p) => 'lit' in p)) {
        const text = pieces.map((p) => (p as { lit: string }).lit).join('')
        return `'${text.replace(/'/g, `'\\''`)}'`
    }
    // double quotes so the variable expands; ! is closed out of them because interactive shells expand history inside "..."
    const body = pieces.map((p) => ('env' in p ? `\${${p.env}}` : p.lit.replace(POSIX_DQ_SPECIAL, '\\$&').replace(/!/g, `"'!'"`))).join('')
    return `"${body}"`
}

function powershellWord(pieces: Piece[]): string {
    if (pieces.every((p) => 'lit' in p)) {
        const text = pieces.map((p) => (p as { lit: string }).lit).join('')
        return `'${text.replace(PS_SQ_QUOTES, '$&$&')}'`
    }
    const body = pieces.map((p, i) => {
        if ('lit' in p) return p.lit.replace(PS_DQ_SPECIAL, '`$&')
        const next = pieces[i + 1]
        // braces keep the name from swallowing a following word character
        return next && 'lit' in next && /^[\w:?]/.test(next.lit) ? `\${env:${p.env}}` : `$env:${p.env}`
    }).join('')
    return `"${body}"`
}

/** The URL with every query value turned into a variable reference. Query names stay: they are what the server reads. */
function urlPieces(url: string): Piece[] {
    const cut = url.indexOf('#')
    const noFragment = cut === -1 ? url : url.slice(0, cut)
    const q = noFragment.indexOf('?')
    if (q === -1) return [lit(noFragment)]
    const pieces: Piece[] = [lit(noFragment.slice(0, q + 1))]
    noFragment.slice(q + 1).split('&').forEach((pair, i) => {
        if (i > 0) pieces.push(lit('&'))
        const eq = pair.indexOf('=')
        if (eq === -1 || eq === pair.length - 1) { pieces.push(lit(pair)); return }
        const rawName = pair.slice(0, eq)
        let name = rawName
        try { name = decodeURIComponent(rawName) } catch { /* keep the raw name */ }
        pieces.push(lit(`${rawName}=`), env(envNameFor(name)))
    })
    return pieces
}

interface RequestFacts { url: string; method: string; headerNames: string[]; lastEventId: string }

function requestOf(capture: RedactedCapture): RequestFacts {
    const connect = ofKind(capture.records, 'connect')[0]
    const request = capture.header.request
    const lastEventId = connect?.sentLastEventId ?? ''
    if (request) return { url: request.url, method: request.method, headerNames: Object.keys(request.headers), lastEventId }
    // no request in the header: the connect record has the names of the headers that were sent, never their values
    return { url: connect?.url ?? '', method: connect?.method ?? 'GET', headerNames: connect?.headerNames ?? [], lastEventId }
}

export function toCurl(capture: RedactedCapture, opts: CurlOptions = {}): string {
    const shell = opts.shell ?? 'posix'
    const word = shell === 'powershell' ? powershellWord : posixWord
    const req = requestOf(capture)

    // one option and its value per line, so a long command stays readable and each line can be edited
    // (curl is an alias of Invoke-WebRequest in Windows PowerShell, so the real binary is named)
    const lines: string[] = [`${shell === 'powershell' ? 'curl.exe' : 'curl'} -N`]
    if (req.method.toUpperCase() !== 'GET') lines.push(`-X ${word([lit(req.method)])}`)
    lines.push(`-H ${word([lit('Accept: text/event-stream')])}`)
    const seen = new Set<string>()
    for (const name of req.headerNames) {
        const lower = name.toLowerCase()
        if (lower === 'accept' || lower === 'last-event-id' || seen.has(lower)) continue // Accept and Last-Event-ID are written separately
        seen.add(lower)
        lines.push(`-H ${word([lit(`${name}: `), env(envNameFor(name))])}`)
    }
    if (req.lastEventId !== '') lines.push(`-H ${word([lit(`Last-Event-ID: ${req.lastEventId}`)])}`)
    lines.push(word(req.url === '' ? [env('STREAM_URL')] : urlPieces(req.url)))
    const joiner = shell === 'powershell' ? ' `\n  ' : ' \\\n  '
    return lines.join(joiner)
}
