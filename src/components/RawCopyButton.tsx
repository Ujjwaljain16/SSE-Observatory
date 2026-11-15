import { useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import type { Theme } from '../types'
import { RawCopyDialog } from './RawCopyDialog'

interface Props {
    theme: Theme
    /** The value exactly as it was received. It is handed to `onCopy` unchanged. */
    text: string
    /** Does the copying. Called only after "Copy anyway", once per confirmation, with `text` as it is. */
    onCopy: (text: string) => void
    className?: string
    children: ReactNode
}

/**
 * A Copy button for a raw recorded value. The click asks first (Q19): the value is shown as received and may hold secrets. Every copy
 * asks again; nothing is remembered, and nothing is guessed about which values are sensitive. The dialog is drawn on the page itself, not
 * inside whatever the button sits in, so a transformed or scrolling row cannot trap or clip it.
 */
export function RawCopyButton({ theme, text, onCopy, className, children }: Props) {
    const [asking, setAsking] = useState(false)
    return (
        <>
            <button type="button" onClick={() => setAsking(true)} aria-haspopup="dialog" className={className}>{children}</button>
            {asking && createPortal(
                <RawCopyDialog theme={theme} onCancel={() => setAsking(false)} onConfirm={() => { setAsking(false); onCopy(text) }} />,
                document.body,
            )}
        </>
    )
}
