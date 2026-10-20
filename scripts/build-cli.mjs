// Builds the sse-doctor CLI into dist-cli/ as a complete, self-contained npm package:
//
//   dist-cli/package.json     generated here, never hand-edited (no dependencies: everything is bundled)
//   dist-cli/bin/sse-doctor.mjs   the CLI (shebang added by the bundler)
//   dist-cli/index.mjs        programmatic API (src/core/index.ts)
//   dist-cli/types/           type declarations for that API
//   dist-cli/README.md, LICENSE
//
// The root package stays private. Publishing later is `SSE_DOCTOR_PUBLISH=1 npm publish dist-cli`; nothing here
// publishes anything, and the generated package refuses to publish without that explicit variable.

import { build } from 'esbuild'
import { spawnSync } from 'node:child_process'
import { cpSync, existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

// The public npm name is NOT claimed or checked yet; it is decided when you choose to publish.
const PACKAGE_NAME = 'sse-doctor'
const VERSION = '2.0.0-dev.0'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const out = path.join(root, 'dist-cli')

rmSync(out, { recursive: true, force: true })
mkdirSync(path.join(out, 'bin'), { recursive: true })

const common = { bundle: true, platform: 'node', target: 'node20', format: 'esm', logLevel: 'warning', define: { __VERSION__: JSON.stringify(VERSION) } }

await build({ ...common, entryPoints: [path.join(root, 'src/cli/bin.ts')], outfile: path.join(out, 'bin/sse-doctor.mjs'), banner: { js: '#!/usr/bin/env node' } })
await build({ ...common, entryPoints: [path.join(root, 'src/core/index.ts')], outfile: path.join(out, 'index.mjs') })

// Type declarations for the programmatic API (emitDeclarationOnly, see tsconfig.dts.json).
const tsc = spawnSync(process.execPath, [path.join(root, 'node_modules/typescript/bin/tsc'), '-p', path.join(root, 'tsconfig.dts.json')], { cwd: root, stdio: 'inherit' })
if (tsc.status !== 0) throw new Error('type declaration build failed')

const pkg = {
    name: PACKAGE_NAME,
    version: VERSION,
    description: 'Find out why an SSE stream is stuck, delayed or losing events, and turn the diagnosis into a repeatable test.',
    type: 'module',
    license: 'MIT',
    engines: { node: '>=20' },
    repository: { type: 'git', url: 'git+https://github.com/Ujjwaljain16/SSE-Observatory.git' },
    bin: { [PACKAGE_NAME]: './bin/sse-doctor.mjs' },
    main: './index.mjs',
    types: './types/core/index.d.ts',
    exports: {
        '.': { types: './types/core/index.d.ts', import: './index.mjs' },
        './package.json': './package.json',
    },
    files: ['bin', 'index.mjs', 'types', 'README.md', 'LICENSE'],
    scripts: {
        prepublishOnly: "node -e \"if(process.env.SSE_DOCTOR_PUBLISH!=='1'){console.error('Refusing to publish: set SSE_DOCTOR_PUBLISH=1 to confirm.');process.exit(1)}\"",
    },
}
writeFileSync(path.join(out, 'package.json'), JSON.stringify(pkg, null, 2) + '\n')
writeFileSync(path.join(out, 'README.md'), `# ${PACKAGE_NAME}\n\n${pkg.description}\n\nPart of [SSE Observatory](https://github.com/Ujjwaljain16/SSE-Observatory). Run \`npx ${PACKAGE_NAME} --help\`.\n`)
if (existsSync(path.join(root, 'LICENSE'))) cpSync(path.join(root, 'LICENSE'), path.join(out, 'LICENSE'))

console.log(`built ${PACKAGE_NAME}@${VERSION} -> dist-cli/`)
