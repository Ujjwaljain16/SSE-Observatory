import type { Theme } from '../types'
import { RAW_VALUES_LABEL } from '../utils/rawValues'

/** A plain label for a view that shows recorded values exactly as received. A block `span`, so it can sit inside a paragraph or a chip. */
export function RawValuesLabel({ theme, className = '' }: { theme: Theme; className?: string }) {
    return (
        <span
            data-testid="raw-values-label"
            className={`block text-xs font-semibold ${theme === 'dark' ? 'text-amber-200' : 'text-amber-900'} ${className}`}
        >
            {RAW_VALUES_LABEL}
        </span>
    )
}
