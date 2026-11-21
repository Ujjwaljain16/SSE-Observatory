// Finds what grows on a long stream: two heap snapshots of the page, a few minutes apart, each after a garbage collection, compared by
// what the objects are (constructor or kind, and name) so the growth shows up as "N more of these, M more bytes".
//
//   NODE_ENV=production PROXY_OPEN=1 ALLOW_PRIVATE_TARGETS=1 PORT=3001 node server.js     (a production build in dist/)
//   npm run chaos
//   node scripts/perf/heap-diff.mjs --first 120 --second 480 --freq 500     (BROWSER_CHANNEL=chrome to use an installed Chrome)
//
// Only the page's main thread is looked at. The page's heap is what the soak measures (CDP Performance.getMetrics JSHeapUsedSize).

import { chromium } from '@playwright/test'

const args = process.argv.slice(2)
const flag = (name, fallback) => { const i = args.indexOf(`--${name}`); return i >= 0 ? args[i + 1] : fallback }
const FIRST = Number(flag('first', 120))
const SECOND = Number(flag('second', 480))
const FREQ = Number(flag('freq', 500))
const APP = flag('app', 'http://localhost:3001')
const CHAOS = flag('chaos', 'http://localhost:4000')
const TOP = Number(flag('top', 30))

const browser = await chromium.launch(process.env.BROWSER_CHANNEL ? { channel: process.env.BROWSER_CHANNEL, args: ['--enable-precise-memory-info'] } : { args: ['--enable-precise-memory-info'] })
const page = await (await browser.newContext({ viewport: { width: 1280, height: 900 } })).newPage()
const cdp = await page.context().newCDPSession(page)
await cdp.send('HeapProfiler.enable')
await cdp.send('Performance.enable')

await page.goto(APP)
await page.getByTestId('url-input').fill(`${CHAOS}/api/stream?freq=${FREQ}`)
await page.getByTestId('connect-button').click()
await page.getByTestId('event-row').first().waitFor({ timeout: 30000 })

const heapMB = async () => { const { metrics } = await cdp.send('Performance.getMetrics'); return Math.round((metrics.find((m) => m.name === 'JSHeapUsedSize')?.value ?? 0) / 1e5) / 10 }

async function snapshot() {
    await cdp.send('HeapProfiler.collectGarbage')
    const chunks = []
    const onChunk = (e) => chunks.push(e.chunk)
    cdp.on('HeapProfiler.addHeapSnapshotChunk', onChunk)
    await cdp.send('HeapProfiler.takeHeapSnapshot', { reportProgress: false })
    cdp.off('HeapProfiler.addHeapSnapshotChunk', onChunk)
    return JSON.parse(chunks.join(''))
}

/** Count and self size of the objects in a snapshot, grouped by kind and name. */
function aggregate(snap) {
    const { node_fields: fields, node_types: types } = snap.snapshot.meta
    const n = fields.length
    const typeIdx = fields.indexOf('type')
    const nameIdx = fields.indexOf('name')
    const sizeIdx = fields.indexOf('self_size')
    const typeNames = types[typeIdx]
    const groups = new Map()
    for (let i = 0; i < snap.nodes.length; i += n) {
        const type = typeNames[snap.nodes[i + typeIdx]]
        let name = snap.strings[snap.nodes[i + nameIdx]]
        // Strings and numbers differ by value; group them by kind (the content is not interesting, how many of them is).
        if (type === 'string' || type === 'concatenated string' || type === 'sliced string' || type === 'number' || type === 'hidden' || type === 'synthetic') name = ''
        if (type === 'closure' || type === 'code') name = name.slice(0, 60)
        const key = `${type}:${name}`
        const g = groups.get(key) ?? { count: 0, size: 0 }
        g.count++
        g.size += snap.nodes[i + sizeIdx]
        groups.set(key, g)
    }
    return groups
}

await page.waitForTimeout(FIRST * 1000)
const heap1 = await heapMB()
const snapA = await snapshot()
const a = aggregate(snapA)
console.log(`snapshot 1 at ${FIRST} s: held heap ${heap1} MB`)
await page.waitForTimeout((SECOND - FIRST) * 1000)
const heap2 = await heapMB()
const snapB = await snapshot()
const b = aggregate(snapB)
console.log(`snapshot 2 at ${SECOND} s: held heap ${heap2} MB`)
const rows = [...b.entries()].map(([key, g]) => { const before = a.get(key) ?? { count: 0, size: 0 }; return { key, dCount: g.count - before.count, dKB: Math.round((g.size - before.size) / 102.4) / 10, count: g.count } })
rows.sort((x, y) => y.dKB - x.dKB)
console.log(`\nGrowth by object kind and name (top ${TOP} by bytes), ${SECOND - FIRST} s apart at ${FREQ} events/s:\n`)
console.log('| kind:name | objects added | KB added | objects now |')
console.log('|---|---|---|---|')
for (const r of rows.slice(0, TOP)) console.log(`| ${r.key || '(unnamed)'} | ${r.dCount} | ${r.dKB} | ${r.count} |`)
await browser.close()

/** Who keeps the objects that appeared between the two snapshots alive: the owner path of each new object, grouped. */
function owners(before, after) {
    const f = after.snapshot.meta.node_fields
    const n = f.length
    const idI = f.indexOf('id'), typeI = f.indexOf('type'), nameI = f.indexOf('name'), sizeI = f.indexOf('self_size'), ecI = f.indexOf('edge_count')
    const ef = after.snapshot.meta.edge_fields
    const m = ef.length
    const etI = ef.indexOf('type'), enI = ef.indexOf('name_or_index'), toI = ef.indexOf('to_node')
    const typeNames = after.snapshot.meta.node_types[typeI]
    const edgeTypes = after.snapshot.meta.edge_types[etI]
    const old = new Set()
    for (let i = 0; i < before.nodes.length; i += before.snapshot.meta.node_fields.length) old.add(before.nodes[i + before.snapshot.meta.node_fields.indexOf('id')])
    // first retainer of every node (skipping weak edges), found by walking all edges once
    const parent = new Int32Array(after.nodes.length / n).fill(-1)
    const parentEdge = new Array(after.nodes.length / n)
    let edge = 0
    for (let i = 0; i < after.nodes.length; i += n) {
        const from = i / n
        const count = after.nodes[i + ecI]
        for (let e = 0; e < count; e++, edge += m) {
            const t = edgeTypes[after.edges[edge + etI]]
            if (t === 'weak') continue
            const to = after.edges[edge + toI] / n
            if (parent[to] === -1) {
                parent[to] = from
                const nm = after.edges[edge + enI]
                parentEdge[to] = t === 'element' || t === 'hidden' ? '[]' : after.strings[nm]
            }
        }
    }
    const label = (node) => { const t = typeNames[after.nodes[node * n + typeI]]; const nm = after.strings[after.nodes[node * n + nameI]]; return t === 'object' || t === 'closure' ? nm.slice(0, 30) : t }
    const groups = new Map()
    for (let i = 0; i < after.nodes.length; i += n) {
        if (old.has(after.nodes[i + idI])) continue
        let node = i / n
        const path = [label(node)]
        for (let depth = 0; depth < 7 && parent[node] !== -1; depth++) {
            path.push(String(parentEdge[node]).slice(0, 30))
            node = parent[node]
            path.push(label(node))
            if (typeNames[after.nodes[node * n + typeI]] === 'synthetic') break
        }
        const key = path.join(' <- ')
        const g = groups.get(key) ?? { count: 0, size: 0 }
        g.count++
        g.size += after.nodes[i + sizeI]
        groups.set(key, g)
    }
    return [...groups.entries()].sort((x, y) => y[1].size - x[1].size)
}
console.log('\nWho holds the new objects (first retainer path, most bytes first):\n')
for (const [key, g] of owners(snapA, snapB).slice(0, 25)) console.log(`${Math.round(g.size / 102.4) / 10} KB, ${g.count} objects: ${key}`)
