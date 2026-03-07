import { describe, it, expect, vi } from 'vitest'
import { render } from '@testing-library/react'
import { EventTimeline } from '../EventTimeline'

// Mock the Recharts components so they render as simple divs for stable snapshotting
vi.mock('recharts', () => ({
    ResponsiveContainer: ({ children }: any) => <div data-testid="recharts-container">{children}</div>,
    ComposedChart: ({ children }: any) => <div data-testid="composed-chart">{children}</div>,
    Line: () => <div data-testid="line-chart" />,
    Bar: () => <div data-testid="bar-chart" />,
    XAxis: () => <div data-testid="x-axis" />,
    YAxis: () => <div data-testid="y-axis" />,
    CartesianGrid: () => <div data-testid="grid" />,
    Tooltip: () => <div data-testid="tooltip" />,
    Brush: () => <div data-testid="brush" />
}))

describe('EventTimeline - Rendering Snapshots', () => {

    const createMockEvents = (count: number) => {
        return Array.from({ length: count }, (_, i) => ({
            id: `evt-\${i}`,
            arrivalTime: 1000000 + (i * 100), // 100ms apart
            data: { test: true },
            raw: '{}'
        })) as any
    }

    it('matches snapshot with no events', () => {
        const { container } = render(
            <EventTimeline
                theme="dark"
                events={[]}
                currentEventIndex={0}
                onSeek={vi.fn()}
                maxEvents={100}
            />
        )
        expect(container).toMatchSnapshot()
    })

    it('matches snapshot with N events', () => {
        const events = createMockEvents(50)

        const { container } = render(
            <EventTimeline
                theme="dark"
                events={events}
                currentEventIndex={25}
                onSeek={vi.fn()}
                maxEvents={100}
            />
        )
        expect(container).toMatchSnapshot()

        // Ensure standard timeline elements rendered
        expect(container.querySelector('canvas')).toBeInTheDocument()
    })

    it('matches snapshot after filter applied (sparse events)', () => {
        const events = createMockEvents(100)
        // Simulate sparse events due to filtering
        const sparse = events.filter((_e: any, i: number) => i % 10 === 0)

        const { container } = render(
            <EventTimeline
                theme="dark"
                events={sparse}
                currentEventIndex={50}
                onSeek={vi.fn()}
                maxEvents={100}
            />
        )
        expect(container).toMatchSnapshot()
    })
})
