// Campaign H1: what one record costs, stage by stage. The README says the engine costs "about 13 microseconds per record" and that this is the basis of
// the "under 2% CPU at 500 events/s" target, which is not demonstrated end to end. This measures the basis: a Node micro-benchmark (no browser) of
// each place a record is handled, per record, with a warm-up and the median of many runs, so the figure can be checked and watched for regressions.
//
//   node scripts/perf/record-cost.mjs [--records 200000] [--runs 15] [--out record-cost.json] [--baseline record-cost.json]
//
// Stages:  (a) recording     Recorder.record + CaptureStore.append (what the page or worker pays to keep a record)
//          (b) engine        engine.feed with the 15 shipped rules
//          (c) the hop       structuredClone of a batch of 10 records (the worker-to-page message)
//          (d) Doctor sync   DoctorSession.sync of 100 new records while 50,000 are held (the Doctor-only cost)
// The arithmetic that makes the target checkable without a browser: CPU share = records per second x cost per record. 500 events/s is about
// 500-1500 records/s, so 2% of one core allows 0.02 / 1500 = 13 us per record at the worst-case record rate (40 us at 500 records/s).
// Run it on a quiet machine: other work on the machine shows up directly in the numbers (the spread is printed so a noisy run can be recognised).
// With --baseline, exit 1 if any stage got more than 25% slower than the stored figures.

import { build } from 'esbuild'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

const arg = (name, fallback) => { const i = process.argv.indexOf(`--${name}`); return i > 0 ? process.argv[i + 1] : fallback }
const RECORDS = Number(arg('records', '200000'))
const RUNS = Number(arg('runs', '15'))
const WARMUPS = 3
const OUT = arg('out', '')
const BASELINE = arg('baseline', '')
const root = path.resolve(import.meta.dirname, '..', '..')

// bundle the TypeScript the benchmark drives
const tmp = mkdtempSync(path.join(os.tmpdir(), 'record-cost-'))
const bundle = path.join(tmp, 'bench.mjs')
await build({
    stdin: {
        contents: `
            export { Recorder } from './src/core/observe/recorder'
            export { CaptureStore } from './src/core/observe/captureStore'
            export { createEngine } from './src/core/diagnostics/engine'
            export { DoctorSession } from './src/doctor/doctorSession'
        `,
        resolveDir: root, loader: 'ts', sourcefile: 'entry.ts',
    },
    bundle: true, platform: 'node', format: 'esm', outfile: bundle, logLevel: 'error', target: 'node20',
})
const { Recorder, CaptureStore, createEngine, DoctorSession } = await import(pathToFileURL(bundle).href)

/** A stream shaped like a busy real one: about 1.5 records per event (a chunk, an event, now and then a heartbeat comment and a second chunk). */
function drafts(count) {
    const out = [
        { kind: 'connect', attempt: 0, url: 'https://stream.test/e', method: 'GET', headerNames: ['accept'], sentLastEventId: '' },
        { kind: 'response', status: 200, contentType: 'text/event-stream', redirected: false, headers: { 'content-type': 'text/event-stream' }, ttfbMs: 5 },
        { kind: 'phase', phase: 'open', info: { attempt: 0 } },
    ]
    let id = 0
    while (out.length < count) {
        id++
        out.push({ kind: 'chunk', bytes: 120 })
        out.push({ kind: 'event', event: 'tick', sseId: String(id), dataBytes: 90, dataHash: id.toString(16), extracted: { seq: id, shape: '$:o|id:n|price:n|qty:n' } })
        if (id % 4 === 0) { out.push({ kind: 'chunk', bytes: 14 }); out.push({ kind: 'comment', text: ' keep-alive', source: 'upstream' }) }
    }
    return out.slice(0, count)
}

/** Stamped records, as a recorder makes them. */
function records(count) {
    const store = new CaptureStore()
    const recorder = new Recorder({ onRecord: (o) => store.append(o) })
    for (const d of drafts(count)) recorder.record(d)
    return store.snapshot()
}

const nowNs = () => process.hrtime.bigint()
const median = (xs) => { const s = [...xs].sort((a, b) => a - b); return s[Math.floor(s.length / 2)] }

/** ns per record: warm-ups discarded, then the median of RUNS timed runs of `work`, each handling `perRun` records. */
function measure(name, perRun, work) {
    for (let i = 0; i < WARMUPS; i++) work()
    const per = []
    for (let i = 0; i < RUNS; i++) {
        const start = nowNs()
        work()
        per.push(Number(nowNs() - start) / perRun)
    }
    const m = median(per)
    return { stage: name, medianNs: Math.round(m), minNs: Math.round(Math.min(...per)), maxNs: Math.round(Math.max(...per)), spreadPct: Math.round(((Math.max(...per) - Math.min(...per)) / m) * 100) }
}

const results = []
const input = drafts(RECORDS)
const stamped = records(RECORDS)

results.push(measure('(a) recording: Recorder.record + CaptureStore.append', RECORDS, () => {
    const store = new CaptureStore()
    const recorder = new Recorder({ onRecord: (o) => store.append(o) })
    for (const d of input) recorder.record(d)
}))

results.push(measure('(b) engine.feed with the 15 shipped rules', RECORDS, () => {
    const engine = createEngine()
    for (const o of stamped) engine.feed(o)
}))

const batches = []
for (let i = 0; i < stamped.length; i += 10) batches.push(stamped.slice(i, i + 10))
results.push(measure('(c) the hop: structuredClone of a batch of 10', RECORDS, () => { for (const b of batches) structuredClone(b) }))

{
    // (d) fill a store with 50,000 records, sync once, then add 100 and sync again, over and over
    const held = 50_000
    const fresh = records(held + 100 * 200)
    const store = new CaptureStore({ capBytes: 1 << 30 })
    for (const o of fresh.slice(0, held)) store.append(o)
    const session = new DoctorSession('bench')
    const entry = { streamId: 'bench', captureId: 'c', store, consumer: [], version: 1 }
    session.sync(entry, 0, undefined)
    let next = held
    let seq = held + 1_000_000 // each appended record needs a number above the last, and counting must not cost anything itself
    results.push(measure('(d) Doctor sync: 100 new records while 50,000 are held', 100 * 20, () => {
        for (let k = 0; k < 20; k++) {
            if (next + 100 > fresh.length) next = held // a run out of fresh records: the store keeps growing, which is the case being measured
            for (let i = 0; i < 100; i++) store.append({ ...fresh[next + i], seq: ++seq })
            next += 100
            entry.version++
            session.sync(entry, k, undefined)
        }
    }))
}

rmSync(tmp, { recursive: true, force: true })

const doctorAdded = results[1].medianNs + results[2].medianNs + results[3].medianNs
console.log(`Node ${process.version}, ${os.cpus()[0]?.model}, ${os.cpus().length} CPUs; ${RECORDS} records, ${WARMUPS} warm-ups, median of ${RUNS} runs\n`)
console.log('stage'.padEnd(66) + 'median'.padStart(10) + 'min'.padStart(9) + 'max'.padStart(9) + 'spread'.padStart(8))
for (const r of results) console.log(r.stage.padEnd(66) + `${(r.medianNs / 1000).toFixed(2)} us`.padStart(10) + `${(r.minNs / 1000).toFixed(2)}`.padStart(9) + `${(r.maxNs / 1000).toFixed(2)}`.padStart(9) + `${r.spreadPct}%`.padStart(8))
console.log(`\nDoctor-added cost per record (b + c + d): ${(doctorAdded / 1000).toFixed(2)} us. Budget for 2% of one core at 1,500 records/s: 13.3 us.`)
console.log(doctorAdded <= 13_300 ? 'Within that budget on this machine, in this micro-benchmark. This is not the browser measurement.' : 'ABOVE that budget on this machine.')
const noisy = results.filter((r) => r.spreadPct > 30)
if (noisy.length > 0) console.log(`\nNote: ${noisy.length} stage(s) varied by more than 30% between runs; the machine was probably busy. Run again on a quiet machine before trusting these.`)

const summary = { node: process.version, cpu: os.cpus()[0]?.model, cpus: os.cpus().length, records: RECORDS, runs: RUNS, date: new Date().toISOString(), stages: results, doctorAddedNsPerRecord: doctorAdded }
if (OUT) writeFileSync(OUT, JSON.stringify(summary, null, 2) + '\n')

if (BASELINE && existsSync(BASELINE)) {
    const base = JSON.parse(readFileSync(BASELINE, 'utf8'))
    const worse = results.filter((r) => { const b = base.stages.find((x) => x.stage === r.stage); return b && r.medianNs > b.medianNs * 1.25 })
    if (worse.length > 0) { console.log(`\nSlower than the baseline by more than 25%: ${worse.map((w) => w.stage).join('; ')}`); process.exit(1) }
    console.log('\nNo stage is more than 25% slower than the baseline.')
}
