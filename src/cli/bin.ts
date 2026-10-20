import { main } from './index'

// Bundled to dist-cli/bin/sse-doctor.mjs (the build adds the shebang). Excluded from coverage: it only wires process.*.
main(process.argv.slice(2), {
    out: (text) => { process.stdout.write(text) },
    err: (text) => { process.stderr.write(text) },
}).then(
    (code) => { process.exitCode = code },
    (error: unknown) => {
        process.stderr.write(`sse-doctor crashed: ${error instanceof Error ? error.message : String(error)}\n`)
        process.exitCode = 3
    },
)
