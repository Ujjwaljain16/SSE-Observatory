// Runs event filtering off the main thread (see filterEngine.ts for the logic).
//
// main → worker: ADD_EVENTS | CLEAR | CONFIG | QUERY_UPDATE | CUSTOM_FILTERS_UPDATE | PING
// worker → main: FILTERED_EVENTS { events (newest first), execMs } | READY

import type { EventMessage } from '../types'
import { isFilterWorkerRequest } from './contracts'
import { FilterEngine, type SerializedFilter } from './filterEngine'

const engine = new FilterEngine()

const timed = (fn: () => void) => {
    const t0 = performance.now()
    fn()
    return +(performance.now() - t0).toFixed(2)
}

const post = (execMs: number) => {
    self.postMessage({ type: 'FILTERED_EVENTS', events: engine.snapshot(), execMs })
}

export const _onMessage = (e: MessageEvent) => {
    const req: unknown = e.data
    if (!isFilterWorkerRequest(req)) return

    switch (req.type) {
        case 'PING':
            self.postMessage({ type: 'READY' })
            return

        case 'CONFIG': {
            let changed = false
            const ms = timed(() => { changed = engine.configure(req.maxEvents) })
            if (changed) post(ms)
            return
        }

        case 'ADD_EVENTS': {
            let changed = false
            const ms = timed(() => { changed = engine.addEvents(req.events as EventMessage[]) })
            if (changed) post(ms) // nothing matched and nothing was trimmed → no message, no clone
            return
        }

        case 'CLEAR':
            engine.clear()
            post(0)
            return

        case 'QUERY_UPDATE':
            post(timed(() => engine.setQuery(req.query, req.search)))
            return

        case 'CUSTOM_FILTERS_UPDATE':
            post(timed(() => engine.setCustomFilters((req.filters ?? []) as SerializedFilter[])))
            return
    }
}

self.addEventListener('message', _onMessage)
