import { readdir, readFile, writeFile } from 'node:fs/promises'
import { main } from './index'

// Bundled to dist-cli/bin/sse-doctor.mjs (the build adds the shebang). Excluded from coverage: it only wires process.*.
const controller = new AbortController()
process.on('SIGINT', () => controller.abort())

main(process.argv.slice(2), {
    out: (text) => { process.stdout.write(text) },
    err: (text) => { process.stderr.write(text) },
    readText: (path) => readFile(path, 'utf8'),
    writeText: (path, text) => writeFile(path, text, 'utf8'),
    listDir: (dir) => readdir(dir),
    env: process.env,
    signal: controller.signal,
}).then(
    (code) => { process.exitCode = code },
    (error: unknown) => {
        process.stderr.write(`sse-doctor crashed: ${error instanceof Error ? error.message : String(error)}\n`)
        process.exitCode = 3
    },
)
