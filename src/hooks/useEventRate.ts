import { useEffect, useRef, useState } from 'react'
import type { EventMessage } from '../types'
import { eventRate } from '../utils/eventStats'

/**
 * Events per second over the last few seconds, updated once a second while `active` (a decaying figure needs a clock: with no events
 * nothing else would re-render it). It reads the latest events from a ref, so a fast stream does not re-render the page for it.
 */
export function useEventRate(events: readonly EventMessage[], active: boolean, windowMs = 5000): number {
    const latest = useRef(events)
    latest.current = events
    const [rate, setRate] = useState(0)
    useEffect(() => {
        if (!active) { setRate(0); return }
        const tick = () => setRate(eventRate(latest.current, Date.now(), windowMs))
        tick()
        const timer = setInterval(tick, 1000)
        return () => clearInterval(timer)
    }, [active, windowMs])
    return rate
}
