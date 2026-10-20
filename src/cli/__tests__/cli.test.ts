import { describe, it, expect } from 'vitest'
import { main, EXIT, version } from '../index'

function run(argv: string[]) {
    let out = ''
    let err = ''
    return main(argv, { out: (t) => { out += t }, err: (t) => { err += t } }).then((code) => ({ code, out, err }))
}

describe('sse-doctor CLI skeleton', () => {
    it('prints its version', async () => {
        const r = await run(['--version'])
        expect(r).toEqual({ code: EXIT.ok, out: `${version()}\n`, err: '' })
    })

    it('prints help with no arguments and for --help', async () => {
        for (const argv of [[], ['--help'], ['help']]) {
            const r = await run(argv)
            expect(r.code).toBe(EXIT.ok)
            expect(r.out).toContain('Usage: sse-doctor')
        }
    })

    it('selftest runs the bundled core and passes', async () => {
        const r = await run(['selftest'])
        expect(r.code).toBe(EXIT.ok)
        expect(r.out).toContain('selftest passed')
        expect(r.err).toBe('')
    })

    it('an unknown command is a usage error (exit 2), not a crash', async () => {
        const r = await run(['frobnicate'])
        expect(r.code).toBe(EXIT.usage)
        expect(r.err).toContain('Unknown command: frobnicate')
    })
})
