// Cross-platform replacement for `mkdir -p dist/docs && cp -r … && cp public/logo.png …`.
import { cpSync, mkdirSync, rmSync, existsSync } from 'node:fs'

const src = 'docs/.vitepress/dist'
const out = 'dist/docs'
if (!existsSync(src)) {
    console.error(`Expected VitePress output at ${src}; run "vitepress build docs" first.`)
    process.exit(1)
}
rmSync(out, { recursive: true, force: true })
mkdirSync(out, { recursive: true })
cpSync(src, out, { recursive: true })
cpSync('public/logo.png', `${out}/logo.png`)
console.log(`Copied documentation site to ${out}`)
