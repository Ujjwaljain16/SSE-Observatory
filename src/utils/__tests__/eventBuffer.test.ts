import { describe, it, expect } from 'vitest'
import { newEventsSince } from '../eventBuffer'
import type { EventMessage } from '../../types'

const ev = (id: string) => ({ id, type: 'message', timestamp: '', data: '', raw: '' }) as EventMessage
const ids = (list: EventMessage[]) => list.map((e) => e.id)

describe('newEventsSince', () => {
    it('returns everything (oldest first) when nothing was forwarded yet', () => {
        expect(ids(newEventsSince([ev('c'), ev('b'), ev('a')], null))).toEqual(['a', 'b', 'c'])
        expect(newEventsSince([], null)).toEqual([])
    })

    it('returns only the events newer than the last forwarded one', () => {
        expect(ids(newEventsSince([ev('e'), ev('d'), ev('c'), ev('b')], 'c'))).toEqual(['d', 'e'])
        expect(newEventsSince([ev('c'), ev('b')], 'c')).toEqual([])
    })

    it('works when the ring buffer is full and its length never changes', () => {
        let buf = [ev('3'), ev('2'), ev('1')]
        let last = buf[0].id
        const forwarded: string[] = []
        for (let i = 4; i <= 10; i++) {
            buf = [ev(String(i)), ...buf].slice(0, 3) // still length 3
            forwarded.push(...ids(newEventsSince(buf, last)))
            last = buf[0].id
        }
        expect(forwarded).toEqual(['4', '5', '6', '7', '8', '9', '10'])
    })

    it('treats an evicted or unknown last id as "everything is new"', () => {
        expect(ids(newEventsSince([ev('z'), ev('y')], 'gone'))).toEqual(['y', 'z'])
    })

    it('handles several events arriving in one render', () => {
        expect(ids(newEventsSince([ev('5'), ev('4'), ev('3'), ev('2'), ev('1')], '2'))).toEqual(['3', '4', '5'])
    })
})
