import { describe, expect, it } from 'vitest'
import { csvCell, getEventStats } from '../exportUtils'
import type { EventMessage } from '../../types'

const ev = (type: string): EventMessage => ({ id: '1', timestamp: '', type, data: '{}', raw: '' })

describe('S21: CSV cells', () => {
    it('are always quoted, so a comma or a line break cannot shift the columns', () => {
        expect(csvCell('a,b')).toBe('"a,b"')
        expect(csvCell('line1\nline2')).toBe('"line1\nline2"')
        expect(csvCell('say "hi"')).toBe('"say ""hi"""')
    })

    it.each(['=1+1', '+SUM(A1)', '-2+3', '@cmd', '\tcmd', '\rcmd'])('%j is shown as text, not run as a formula', (value) => {
        expect(csvCell(value).startsWith('"\'')).toBe(true)
    })

    it('leaves ordinary text and numbers as they are', () => {
        expect(csvCell('message')).toBe('"message"')
        expect(csvCell('12.5')).toBe('"12.5"')
    })
})

describe('S21: event statistics', () => {
    it('count an event named __proto__ or constructor like any other', () => {
        const stats = getEventStats([ev('__proto__'), ev('__proto__'), ev('constructor'), ev('message')])
        expect(stats.total).toBe(4)
        expect(stats.uniqueTypes).toBe(3)
        expect(stats.topTypes[0]).toEqual(['__proto__', 2])
    })
})
