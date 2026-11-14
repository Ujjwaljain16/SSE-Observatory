// What the build ships, read as a stranger would read it: no trace of the machine that built it, no hidden dependency, no source map, no
// leaked `src/` in the type declarations, and a self test that passes from a clean directory with nothing but the one file. Run after
// `npm run build:cli`:  npm run doctor:buildcheck
//
// Campaign E7. `cli:check` (scripts/cli-pack-check.mjs) already packs, allow-lists the package files, enforces the size budget and zero dependencies
// and runs the installed package; this adds what it does not look at: the CONTENT of the files.
//
// A check that cannot fail proves nothing, so the scanners are tested first against planted text ("the scanners can fail"), then run on the
// real build.

import { spawnSync } from 'node:child_process'
import assert from 'node:assert/strict'
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { after, describe, it } from 'node:test'

const ROOT = path.resolve(import.meta.dirname, '..')
const DIST = path.join(ROOT, 'dist-cli')
const BIN = path.join(DIST, 'bin', 'sse-doctor.mjs')
const TYPES = path.join(DIST, 'types')

// ------------------------------------------------------------------------------------------------------------------------------ scanners

/** Every spelling of a concrete path as it could be embedded in generated JavaScript, JSON or a `file://` URL. All compared lower-case. */
function spellings(p) {
    const fwd = p.replace(/\\/g, '/')
    const back = p.replace(/\//g, '\\')
    return [...new Set([p, fwd, back, back.replace(/\\/g, '\\\\'), encodeURI(fwd)])].map((s) => s.toLowerCase()).filter((s) => s.length >= 4)
}

/** Concrete things that identify the machine that ran the build: where the repository is, who the user is, where their home is. */
export function machineMarkers(env = {}) {
    const roots = new Set()
    for (const p of [ROOT, safeReal(ROOT), safeReal(path.join(ROOT, 'node_modules')), os.homedir(), env.cwd]) if (p) roots.add(p)
    const paths = [...roots].flatMap(spellings)
    const names = []
    const user = os.userInfo().username
    // a user name is only a marker when it is distinctive ("root" or "user" would be found in ordinary English text), and it is matched as a whole
    // word: the repository owner's GitHub name legitimately starts with the same letters as a local account name
    const generic = new Set(['root', 'user', 'users', 'admin', 'runner', 'node', 'test', 'build', 'ubuntu', 'ci', 'dev', 'github', 'default'])
    if (user.length >= 4 && !generic.has(user.toLowerCase())) names.push(user.toLowerCase())
    return { paths, names }
}
function safeReal(p) { try { return realpathSync(p) } catch { return undefined } }

/** Paths that belong to some build machine, whoever it was: a Windows profile, a macOS or Linux home, a CI workspace, a `file:` URL to a drive. */
const GENERIC_MACHINE_PATHS = [
    { name: 'a Windows user-profile path', re: /\b[A-Za-z]:[\\/]+(?:Users|Documents and Settings)[\\/]/ },
    { name: 'a macOS or Linux home directory', re: /(?:^|[^A-Za-z0-9_.-])\/(?:Users|home)\/[^/\s'"`]+\// },
    { name: 'a CI workspace', re: /(?:\/home\/runner\/work\/|\/github\/workspace|[A-Za-z]:[\\/]+a[\\/]+[^\\/\s]+[\\/]|\/runner\/_work\/|\/builds\/)/ },
    { name: 'a file: URL to a local drive or root', re: /file:\/\/\/(?:[A-Za-z]:|home|Users|tmp|var|private)/ },
    { name: 'a Windows drive path', re: /\b[A-Za-z]:[\\/]+[A-Za-z0-9_.$ -]+[\\/]/ },
]

/** Findings (a list of strings) for one file's text. `kind` is 'js' for the bundles and 'dts' for type declarations. */
export function scanText(text, { kind, markers }) {
    const problems = []
    const lower = text.toLowerCase()
    for (const marker of markers.paths) if (lower.includes(marker)) problems.push(`holds the build machine's own path "${marker}"`)
    for (const name of markers.names) if (new RegExp(`(?<![a-z0-9])${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![a-z0-9])`).test(lower)) problems.push(`holds the build machine's user name "${name}"`)
    for (const { name, re } of GENERIC_MACHINE_PATHS) { const m = re.exec(text); if (m) problems.push(`holds ${name}: ${JSON.stringify(m[0].trim())}`) }
    if (/node_modules/.test(text)) problems.push('mentions node_modules')
    if (/[#@]\s*source(?:Mapping)?URL\s*=/.test(text)) problems.push('has a sourceMappingURL / sourceURL comment')
    if (kind === 'dts') {
        const leak = /(?:^|[^A-Za-z0-9_-])src[\\/]/.exec(text)
        if (leak) problems.push(`leaks the source tree ("src/"): ...${text.slice(Math.max(0, leak.index - 20), leak.index + 40).replace(/\s+/g, ' ')}...`)
        if (/\/\/\/\s*<reference\s+path=/.test(text)) problems.push('has a /// <reference path> directive')
        if (/import\(\s*['"](?:[A-Za-z]:|\/)/.test(text)) problems.push('imports by absolute path')
    }
    return problems
}

/** Bare (package) imports in a bundle: a published, dependency-free CLI must import only node: built-ins and nothing relative. esbuild prints every
 *  real static import at the start of a line with double quotes; text that merely CONTAINS an import (the `repro --test` template writes
 *  `import ... from 'vitest'` with single quotes) is not one. Dynamic `import("x")` and `require("x")` with a literal are looked for everywhere.
 *  (The run from a clean directory below is the other half: an import that resolved only from this checkout would fail to load there.) */
export function externalImports(text) {
    const found = new Set()
    for (const m of text.matchAll(/^import\s+(?:[^"\n;]*?\s+from\s+)?"([^"\n]+)"\s*;?\s*$/gm)) found.add(m[1])
    for (const m of text.matchAll(/(?<![\w$.])import\(\s*(['"])([^'"\n]+)\1\s*\)/g)) found.add(m[2])
    for (const m of text.matchAll(/(?<![\w$.])require\(\s*(['"])([^'"\n]+)\1\s*\)/g)) found.add(m[2])
    return [...found].filter((s) => !s.startsWith('node:'))
}

/** Relative import specifiers of a declaration file, resolved: every one must land on a file inside the types folder. */
export function brokenTypeImports(file, text, typesRoot) {
    const problems = []
    for (const m of text.matchAll(/(?:from|import\()\s*['"](\.{1,2}\/[^'"]*)['"]/g)) {
        const target = path.resolve(path.dirname(file), m[1])
        const inside = path.relative(typesRoot, target)
        if (inside.startsWith('..') || path.isAbsolute(inside)) { problems.push(`imports "${m[1]}", which is outside the types folder`); continue }
        if (![`${target}.d.ts`, path.join(target, 'index.d.ts'), target].some((c) => existsSync(c) && statSync(c).isFile())) problems.push(`imports "${m[1]}", which does not exist`)
    }
    return problems
}

function* walk(dir) {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name)
        if (entry.isDirectory()) yield* walk(full)
        else yield full
    }
}

// ------------------------------------------------------------------------------------------------------------------------------ the scanners can fail

describe('E7: the scanners can fail (planted text)', () => {
    const markers = { paths: spellings('C:\\dev\\SSE-Observatory'), names: ['distinctiveuser'] }
    const flagged = (text, kind = 'js') => scanText(text, { kind, markers })

    it('clean text is clean', () => {
        const clean = '// src/cli/bin.ts\nimport http from "node:http";\nconst help = "run sse-doctor --help"\n'
        assert.deepEqual(flagged(clean), [])
        assert.deepEqual(flagged('export declare function analyze(input: Foo): Bar\nimport type { Foo } from \'./foo\'\n', 'dts'), [])
    })

    const PLANTED = [
        ['the repository path, forward slashes', 'const root = "C:/dev/SSE-Observatory/src"', /own path/],
        ['the repository path, as the escaped backslashes of a JavaScript string literal', 'const root = "C:\\\\dev\\\\SSE-Observatory\\\\src"', /own path/],
        ['the repository path, with single backslashes (a comment)', '// C:\\dev\\SSE-Observatory\\src\\cli\\bin.ts', /own path/],
        ['the repository path in lower case with a lower-case drive', '// c:/dev/sse-observatory/src', /own path/],
        ['the user name', '// built by DistinctiveUser', /user name/],
        ['a Windows profile path of someone else', 'at C:\\Users\\someone\\proj\\x.js:1:2', /Windows user-profile/],
        ['a macOS home', 'at /Users/someone/proj/x.js', /home directory/],
        ['a Linux home', 'at /home/someone/proj/x.js', /home directory/],
        ['a GitHub runner workspace (Linux)', '/home/runner/work/SSE-Observatory/SSE-Observatory/src', /CI workspace|home directory/],
        ['a GitHub runner workspace (Windows)', 'D:\\a\\SSE-Observatory\\SSE-Observatory\\src', /CI workspace|Windows drive path/],
        ['a file: URL to a drive', 'new URL("file:///D:/x/y.js")', /file: URL/],
        ['a node_modules path', '// node_modules/undici/index.js', /node_modules/],
        ['a source map comment', 'code\n//# sourceMappingURL=sse-doctor.mjs.map\n', /sourceMappingURL/],
    ]
    for (const [name, text, expected] of PLANTED) {
        it(`flags ${name}`, () => {
            const problems = flagged(text)
            assert.ok(problems.length > 0, `nothing was flagged in ${JSON.stringify(text)}`)
            assert.match(problems.join('\n'), expected)
        })
    }

    it('a user name is a whole word: a longer name that starts with it (a GitHub owner) is not a leak', () => {
        assert.deepEqual(flagged('"url": "git+https://github.com/DistinctiveUserOfGithub/repo.git"'), [])
        assert.equal(flagged('/* by distinctiveuser. */').length, 1)
    })

    it('flags "src/" in a declaration file, a reference path and an absolute import, but not in a bundle comment', () => {
        assert.match(flagged('import type { A } from "../src/core/a"', 'dts').join('\n'), /src\//)
        assert.match(flagged('declare const x: import("src/core/a").A', 'dts').join('\n'), /src\//)
        assert.match(flagged('/// <reference path="./a.d.ts" />', 'dts').join('\n'), /reference path/)
        assert.match(flagged('type A = import("/abs/a").A', 'dts').join('\n'), /absolute path/)
        assert.deepEqual(flagged('// src/cli/bin.ts', 'js'), [])
        assert.deepEqual(flagged('export type { A } from "./resources/a"', 'dts'), [], 'a folder called "resources" is not "src/"')
    })

    it('finds a package import and ignores text that only contains one', () => {
        assert.deepEqual(externalImports('import http from "node:http";\nimport { x } from "undici";\nawait import("ajv")\nconst t = `import { it } from \'vitest\'`\n'), ['undici', 'ajv'])
        assert.deepEqual(externalImports('import "node:fs";\nimport * as p from "node:path";\nconst tpl = "import { test } from \'vitest\'"\n'), [])
        assert.deepEqual(externalImports('const x = require("lodash")'), ['lodash'])
    })

    it('finds a type import that points outside the folder or at nothing', () => {
        const root = mkdtempSync(path.join(os.tmpdir(), 'sse-types-'))
        try {
            mkdirSync(path.join(root, 'core'))
            const file = path.join(root, 'core', 'a.d.ts')
            writeFileSync(file, 'export {}')
            assert.deepEqual(brokenTypeImports(file, 'import type { B } from "./b"', root).length, 1)
            assert.match(brokenTypeImports(file, 'import type { B } from "../../src/b"', root).join('\n'), /outside the types folder/)
            assert.deepEqual(brokenTypeImports(file, 'import type { B } from "./a"', root), [])
        } finally { rmSync(root, { recursive: true, force: true }) }
    })

    it('the markers include this machine (so the real scan is not looking for a stranger)', () => {
        const markers = machineMarkers()
        assert.ok(markers.paths.some((m) => m.includes(path.basename(ROOT).toLowerCase())), 'the repository folder is a marker')
        assert.ok(markers.paths.some((m) => m.includes(os.homedir().replace(/\\/g, '/').toLowerCase())), 'the home folder is a marker')
    })
})

// ------------------------------------------------------------------------------------------------------------------------------ the real build

if (!existsSync(BIN)) { console.error(`${BIN} does not exist. Run "npm run build:cli" first.`); process.exit(2) }
const tmp = mkdtempSync(path.join(os.tmpdir(), 'sse-buildcheck-'))
after(() => {
    try { chmodSync(path.join(tmp, 'work'), 0o755) } catch { /* it may not exist */ }
    rmSync(tmp, { recursive: true, force: true })
})

describe('E7: the built files', () => {
    const markers = machineMarkers()
    const files = [...walk(DIST)].map((f) => path.relative(DIST, f).replace(/\\/g, '/'))
    const text = (rel) => readFileSync(path.join(DIST, rel), 'utf8')

    it('the build has the files it should (a build that produced nothing would pass every scan below)', () => {
        for (const rel of ['bin/sse-doctor.mjs', 'index.mjs', 'package.json', 'types/core/index.d.ts']) assert.ok(files.includes(rel), `${rel} is missing`)
        assert.ok(statSync(BIN).size > 100_000, 'the CLI bundle is suspiciously small')
        assert.ok(files.filter((f) => f.endsWith('.d.ts')).length > 20, 'too few declaration files')
    })

    it('no source map file anywhere, and nothing but the shipped kinds of file', () => {
        assert.deepEqual(files.filter((f) => /\.map$/i.test(f)), [])
        assert.deepEqual(files.filter((f) => !/^(?:bin\/sse-doctor\.mjs|index\.mjs|package\.json|README\.md|LICENSE|types\/.+\.d\.ts)$/.test(f)), [])
    })

    for (const rel of ['bin/sse-doctor.mjs', 'index.mjs', 'package.json', 'README.md']) {
        it(`${rel}: no machine path or name, no node_modules, no source map comment`, () => {
            assert.deepEqual(scanText(text(rel), { kind: 'js', markers }), [])
        })
    }

    it('types/**/*.d.ts: no machine path, no node_modules, no source map comment, no "src/", no reference path, no absolute import (every file)', () => {
        const problems = []
        for (const rel of files.filter((f) => f.endsWith('.d.ts'))) for (const p of scanText(text(rel), { kind: 'dts', markers })) problems.push(`${rel}: ${p}`)
        assert.deepEqual(problems, [])
    })

    it('types/**/*.d.ts: every relative import lands on a declaration file inside the package', () => {
        const problems = []
        for (const rel of files.filter((f) => f.endsWith('.d.ts'))) for (const p of brokenTypeImports(path.join(DIST, rel), text(rel), TYPES)) problems.push(`${rel}: ${p}`)
        assert.deepEqual(problems, [])
    })

    it('the package manifest points at files that exist, and has no dependencies', () => {
        const manifest = JSON.parse(text('package.json'))
        assert.ok(!manifest.dependencies || Object.keys(manifest.dependencies).length === 0)
        assert.ok(existsSync(path.join(DIST, manifest.bin['sse-doctor'])), 'bin target')
        assert.ok(existsSync(path.join(DIST, manifest.main)), 'main')
        assert.ok(existsSync(path.join(DIST, manifest.types)), 'types')
    })

    it('the bundles import only node: built-ins (nothing the user would have to install, nothing that resolves from this checkout)', () => {
        for (const rel of ['bin/sse-doctor.mjs', 'index.mjs']) assert.deepEqual(externalImports(text(rel)), [], rel)
    })

    it('every "// path" banner esbuild leaves in the bundle is relative to the repository (src/...), never absolute', () => {
        const banners = text('bin/sse-doctor.mjs').split('\n').filter((l) => /^\/\/ \S+\.(?:ts|tsx|js|mjs|json)$/.test(l))
        assert.ok(banners.length > 10, 'the bundle has its usual module banners (so this check is not vacuous)')
        assert.deepEqual(banners.filter((l) => !/^\/\/ (?:src|lib)\//.test(l)), [])
    })
})

// ------------------------------------------------------------------------------------------------------------------------------ run from nowhere

describe('E7: the CLI runs from a clean directory that cannot be written to, with nothing else of this checkout around it', () => {
    const install = path.join(tmp, 'install')
    const work = path.join(tmp, 'work')
    const gone = path.join(tmp, 'does-not-exist') // HOME, TEMP and the config and cache folders all point here: a write there fails, and the folder is checked afterwards
    const run = (args) => {
        const env = { ...process.env, NO_COLOR: '1', HOME: gone, USERPROFILE: gone, APPDATA: gone, LOCALAPPDATA: gone, XDG_CONFIG_HOME: gone, XDG_CACHE_HOME: gone, TMPDIR: gone, TMP: gone, TEMP: gone }
        delete env.NODE_OPTIONS
        delete env.NODE_PATH
        return spawnSync(process.execPath, [path.join(install, 'sse-doctor.mjs'), ...args], { cwd: work, env, encoding: 'utf8', timeout: 60_000, windowsHide: true })
    }
    const listing = (dir) => readdirSync(dir, { recursive: true }).map(String).sort()

    it('set-up: the bundle is the ONLY file copied (outside the repository, no node_modules above it), the working directory is empty and read-only where the platform allows it', () => {
        mkdirSync(install)
        mkdirSync(work)
        copyFileSync(BIN, path.join(install, 'sse-doctor.mjs'))
        chmodSync(work, 0o555) // on Windows this only sets the read-only attribute, which does not stop file creation: the listing check below is what proves nothing was written
        assert.deepEqual(listing(install), ['sse-doctor.mjs'])
        assert.deepEqual(listing(work), [])
        assert.ok(!path.resolve(install).toLowerCase().startsWith(ROOT.toLowerCase()), 'the copy is not inside the repository')
        assert.ok(!existsSync(path.join(install, 'package.json')), 'no package.json beside it ("type": "module" comes from the .mjs extension)')
    })

    it('selftest passes: exit 0, "selftest passed", every check ok, stderr empty', () => {
        const r = run(['selftest'])
        assert.equal(r.status, 0, `exit ${r.status}\n${r.stdout}\n${r.stderr}`)
        assert.match(r.stdout, /selftest passed/)
        const oks = r.stdout.split('\n').filter((l) => l.startsWith('ok '))
        assert.ok(oks.length >= 14, `only ${oks.length} checks ran`)
        assert.doesNotMatch(r.stdout, /^FAIL/m)
        assert.equal(r.stderr, '')
    })

    it('--version is the packaged version, not "dev"', () => {
        const manifest = JSON.parse(readFileSync(path.join(DIST, 'package.json'), 'utf8'))
        const r = run(['--version'])
        assert.equal(r.status, 0)
        assert.equal(r.stdout.trim(), manifest.version)
        assert.notEqual(r.stdout.trim(), 'dev')
    })

    it('a command that reads a file and prints findings also works from there (analyze of a capture handed in by absolute path)', () => {
        const capture = path.join(ROOT, 'public', 'lab', 'h01.sse-capture')
        const r = run(['analyze', capture])
        assert.equal(r.status, 0, `${r.stdout}\n${r.stderr}`)
        assert.match(r.stdout, /No findings/)
        assert.ok(!r.stdout.toLowerCase().includes(ROOT.toLowerCase()) || r.stdout.includes(capture), 'the only path it prints is the one it was given')
    })

    it('it wrote nothing: the working directory and the install folder are as they were, and the "home" it was given was never created', () => {
        assert.deepEqual(listing(work), [])
        assert.deepEqual(listing(install), ['sse-doctor.mjs'])
        assert.equal(existsSync(gone), false)
    })
})
