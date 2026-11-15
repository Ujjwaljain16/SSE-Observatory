import { describe, expect, it } from 'vitest'
import pkg from '../../../package.json'
import { resolveToolVersion, toolVersion } from '../version'
import { newHeader } from '../capture/format'

describe('the tool version', () => {
    it('is "dev" only when no build defined a version', () => {
        expect(resolveToolVersion(undefined, undefined)).toBe('dev')
        expect(resolveToolVersion('', '')).toBe('dev')
    })

    it('uses the command line build version, then the app build version', () => {
        expect(resolveToolVersion('2.1.0', undefined)).toBe('2.1.0')
        expect(resolveToolVersion(undefined, '2.2.0')).toBe('2.2.0')
        expect(resolveToolVersion('2.1.0', '2.2.0')).toBe('2.1.0')
    })

    it("is package.json's version where the build defines it (here: the test config), and never 'dev'", () => {
        expect(toolVersion()).toBe(pkg.version)
        expect(toolVersion()).not.toBe('dev')
    })

    it('is what a new capture header says wrote it', () => {
        expect(newHeader({ kind: 'local-full', source: { kind: 'fixture' } }).tool).toEqual({ name: 'sse-observatory', version: pkg.version })
    })
})
