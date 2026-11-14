// Builds the failure lab: records each built-in fixture and writes the captures the app shows (public/lab).
//   npm run lab:build                  (LAB_SCALE=0.25 by default; LAB_ONLY=f04-silent,h01 to make just some)
// The generator is TypeScript that imports the fixture server, so it is bundled first, like the command line tool is.
import { build } from 'esbuild'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sse-lab-'))
const bundle = path.join(tmp, 'generate.mjs')
await build({
    entryPoints: [path.join(root, 'scripts/lab/generate.ts')],
    outfile: bundle,
    bundle: true,
    platform: 'node',
    format: 'esm',
    target: 'node20',
    logLevel: 'error',
    banner: { js: "import { createRequire } from 'node:module'; const require = createRequire(import.meta.url);" },
})
const run = spawnSync(process.execPath, [bundle, path.join(root, process.argv[2] ?? 'public/lab')], { stdio: 'inherit', cwd: root })
fs.rmSync(tmp, { recursive: true, force: true })
process.exit(run.status ?? 1)
