import { describe, expect, it } from 'vitest'
import pkg from '../../../package.json'
import { prepare } from '../artifacts'
import { captureOf } from '../captureOf'
import { observationRegistry } from '../observationRegistry'
import { parseCapture } from '../../core/capture/format'
import { localCapture } from '../../core/capture/build'
import { healthyStart } from '../../core/testing/captureBuilder'
import type { CaptureRecord } from '../../core/capture/format'

// An export is the evidence a person attaches to a bug report; it has to say which build wrote it (issue #79).
function recording() {
    return localCapture(healthyStart().frame('tick', '1').observations() as CaptureRecord[], {
        source: { kind: 'browser-app', client: 'browser-fetch' },
        request: { url: 'https://stream.test/events', headers: {} },
        captureId: 'abcdef12-0000',
    })
}

describe('the Doctor export says which version of the tool wrote it', () => {
    it.each(['capture-local', 'capture-shared', 'repro'] as const)('%s header', (kind) => {
        const capture = recording()
        const text = prepare(kind, capture, kind === 'repro' ? { findingKey: 'none' } : {}).text
        expect(parseCapture(text).capture.header.tool).toEqual({ name: 'sse-observatory', version: pkg.version })
    })

    it('every report format names it, in the text and in the data', () => {
        const capture = recording()
        for (const kind of ['report-md', 'report-issue', 'report-html'] as const) {
            const out = prepare(kind, capture).text
            expect(out, kind).toContain(`by sse-observatory ${pkg.version}`)
            expect(out, kind).not.toContain('sse-observatory dev')
        }
        const json = JSON.parse(prepare('report-json', capture).text)
        expect(JSON.stringify(json)).toContain(`"version":"${pkg.version}"`)
        expect(JSON.stringify(json)).not.toContain('"version":"dev"')
    })

    it('a snapshot of a live recording (what the app really exports) carries it, through to the shared capture and the report', () => {
        observationRegistry.receive('tv', { captureId: 'cap-tv-1', batch: healthyStart().frame('tick', '1').observations() })
        try {
            const snap = captureOf('tv')!
            expect(snap.capture.header.tool).toEqual({ name: 'sse-observatory', version: pkg.version })
            expect(parseCapture(prepare('capture-shared', snap.capture).text).capture.header.tool.version).toBe(pkg.version)
            expect(prepare('report-md', snap.capture).text).toContain(`by sse-observatory ${pkg.version}`)
        } finally {
            observationRegistry.close('tv')
        }
    })
})
