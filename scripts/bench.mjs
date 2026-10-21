// Browser benchmark for the ingest pipeline. Needs the dev stack and the chaos server running:
//
//   terminal 1:  npm run dev
//   terminal 2:  npm run chaos
//   then:        npm run bench                       (BROWSER_CHANNEL=chrome to use an installed Chrome)
//                node scripts/bench.mjs --throttle 4 (emulate a CPU 4x slower, roughly a small CI runner)
//                node scripts/bench.mjs --doctor all --runs 5   (what the Stream Doctor costs, see below)
//
// Scenarios (each in a fresh page, measured inside the browser):
//   burst      a 20,000 event burst that ends and is reconnected every second: time to the first row, worst
//              main-thread stall, timer lateness, heap
//   sustained  ~500 events/s for 10 s
//
// "timer lateness" is how late a 50 ms timer fires: it is what a user feels as input lag.
//
// --doctor off|closed|open|all   run each scenario with the Doctor in these states and compare them:
//   off     recording switched off (localStorage sse.recording=off): the viewer alone, nothing is recorded or diagnosed
//   closed  recording on and the Doctor button's badge running the diagnostics, panel closed (the normal state)
//   open    the Doctor panel open as well (health strip refreshing every second)
// --runs N   repeat each case N times and report medians (default 1; 5 or more is needed to say anything about a difference)
//
// "main-thread busy" is the share of wall time the page's main thread spent running tasks (CDP Performance.TaskDuration).
// It does not include the SharedWorker, which does the recording; that cost is measured separately by the records/s and
// per-record cost the recorder reports. A difference smaller than the spread between repeated runs of one case is noise.

import { chromium } from '@playwright/test'

const args = process.argv.slice(2)
const flag = (name, fallback) => { const i = args.indexOf(`--${name}`); return i >= 0 ? args[i + 1] : fallback }
const THROTTLE = Number(flag('throttle', 1))
const DOCTOR = flag('doctor', '')
const RUNS = Math.max(1, Number(flag('runs', 1)))
const VARIANTS = DOCTOR === 'all' ? ['off', 'closed', 'open'] : DOCTOR ? DOCTOR.split(',') : ['']
const APP = flag('app', 'http://localhost:3001')
const CHAOS = flag('chaos', 'http://localhost:4000')

const SCENARIOS = [
    { name: 'burst', url: `${CHAOS}/api/burst?count=20000`, seconds: 8 },
    { name: 'sustained', url: `${CHAOS}/api/stream?freq=500`, seconds: 10 },
]

const percentile = (sorted, p) => (sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))] : 0)

const browser = await chromium.launch(process.env.BROWSER_CHANNEL ? { channel: process.env.BROWSER_CHANNEL, args: ['--enable-precise-memory-info'] } : { args: ['--enable-precise-memory-info'] })
const results = []

const median = (xs) => { const s = [...xs].sort((a, b) => a - b); return s.length ? s[Math.floor(s.length / 2)] : 0 }

for (const [scenario, variant, run] of SCENARIOS.flatMap((sc) => VARIANTS.flatMap((v) => Array.from({ length: RUNS }, (_, r) => [sc, v, r])))) {
    const context = await browser.newContext({ viewport: { width: 1280, height: 900 } })
    if (variant === 'off') await context.addInitScript(() => localStorage.setItem('sse.recording', 'off'))
    const page = await context.newPage()
    if (THROTTLE > 1) await (await page.context().newCDPSession(page)).send('Emulation.setCPUThrottlingRate', { rate: THROTTLE })
    await page.goto(APP)
    await page.waitForTimeout(1000)
    if (variant === 'open') await page.getByTestId('doctor-toggle').click()
    const cdp = await page.context().newCDPSession(page)
    await cdp.send('Performance.enable')
    const busy = async () => { const { metrics } = await cdp.send('Performance.getMetrics'); const m = Object.fromEntries(metrics.map((x) => [x.name, x.value])); return { task: m.TaskDuration, script: m.ScriptDuration } }
    await page.evaluate(() => {
        window.__bench = { late: [], frames: [] }
        let last = performance.now()
        setInterval(() => { const now = performance.now(); window.__bench.late.push(Math.max(0, now - last - 50)); last = now }, 50)
        new PerformanceObserver((list) => list.getEntries().forEach((e) => window.__bench.frames.push({ start: e.startTime, duration: e.duration }))).observe({ type: 'long-animation-frame', buffered: true })
    })
    const heapBefore = await page.evaluate(() => performance.memory.usedJSHeapSize)

    await page.getByTestId('url-input').fill(scenario.url)
    await page.evaluate(() => { window.__bench.connectAt = performance.now() }) // ignore the page-load frames before this
    const t0 = Date.now()
    await page.getByTestId('connect-button').click()
    await page.getByTestId('event-row').first().waitFor({ timeout: 30000 })
    const firstRowMs = Date.now() - t0
    const busy0 = await busy()
    const w0 = Date.now()
    await page.waitForTimeout(scenario.seconds * 1000)
    const busy1 = await busy()
    const wall = (Date.now() - w0) / 1000

    const stats = await page.evaluate(() => ({ late: window.__bench.late, frames: window.__bench.frames.filter((f) => f.start >= window.__bench.connectAt).map((f) => f.duration), heap: performance.memory.usedJSHeapSize, rows: document.querySelectorAll('[data-testid="event-row"]').length }))
    const late = [...stats.late].sort((a, b) => a - b)
    results.push({
        scenario: scenario.name,
        variant,
        run,
        mainBusyPct: Math.round(((busy1.task - busy0.task) / wall) * 1000) / 10,
        scriptBusyPct: Math.round(((busy1.script - busy0.script) / wall) * 1000) / 10,
        longFrameTotalMs: Math.round(stats.frames.reduce((a, b) => a + b, 0)),
        firstRowMs,
        timerLateP50: Math.round(percentile(late, 50)),
        timerLateP95: Math.round(percentile(late, 95)),
        timerLateMax: Math.round(late.at(-1) ?? 0),
        longFrames: stats.frames.length,
        worstFrameMs: Math.round(Math.max(0, ...stats.frames)),
        heapMB: Math.round(stats.heap / 1e6),
        heapGrowthMB: Math.round((stats.heap - heapBefore) / 1e6),
        domRows: stats.rows,
    })
    await context.close()
}
await browser.close()

console.log(`\nCPU throttle: ${THROTTLE}x   (${new Date().toISOString().slice(0, 10)})\n`)
if (DOCTOR) {
    console.log(`Doctor variants, medians of ${RUNS} run${RUNS === 1 ? '' : 's'} (spread = min to max)\n`)
    console.log('| scenario | doctor | main-thread busy | script busy | timer late p50 / p95 | long frames (total ms) | worst frame | heap growth |')
    console.log('|---|---|---|---|---|---|---|---|')
    for (const sc of SCENARIOS) {
        for (const v of VARIANTS) {
            const rs = results.filter((r) => r.scenario === sc.name && r.variant === v)
            const span = (key) => `${median(rs.map((r) => r[key]))} (${Math.min(...rs.map((r) => r[key]))} to ${Math.max(...rs.map((r) => r[key]))})`
            console.log(`| ${sc.name} | ${v} | ${span('mainBusyPct')} % | ${span('scriptBusyPct')} % | ${median(rs.map((r) => r.timerLateP50))} / ${median(rs.map((r) => r.timerLateP95))} ms | ${median(rs.map((r) => r.longFrames))} (${median(rs.map((r) => r.longFrameTotalMs))}) | ${median(rs.map((r) => r.worstFrameMs))} ms | ${median(rs.map((r) => r.heapGrowthMB))} MB |`)
        }
    }
    console.log('')
}
console.log('| scenario | first row | timer late p50 / p95 / max | long frames (worst) | heap (growth) | DOM rows |')
console.log('|---|---|---|---|---|---|')
for (const r of results) {
    console.log(`| ${r.scenario} | ${r.firstRowMs} ms | ${r.timerLateP50} / ${r.timerLateP95} / ${r.timerLateMax} ms | ${r.longFrames} (${r.worstFrameMs} ms) | ${r.heapMB} MB (${r.heapGrowthMB >= 0 ? '+' : ''}${r.heapGrowthMB}) | ${r.domRows} |`)
}
console.log('\n' + JSON.stringify({ throttle: THROTTLE, results }))
