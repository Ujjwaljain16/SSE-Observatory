import type { ReactNode } from 'react'

/**
 * Something wider than its column (a table of a dozen figures, a chart) on a narrow screen: it scrolls sideways inside this box instead of being
 * cut off, and the box can be reached and scrolled with the keyboard. It is named, so a screen reader says what it is.
 */
export function ScrollRegion({ label, children }: { label: string; children: ReactNode }) {
    return <div role="region" aria-label={label} tabIndex={0} className="overflow-x-auto">{children}</div>
}
