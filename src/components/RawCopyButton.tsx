import { createContext, useCallback, useContext, useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import type { Theme } from '../types'
import { RawCopyDialog } from './RawCopyDialog'

interface Props {
    theme: Theme
    /** The value exactly as it was received. It is handed to `onCopy` unchanged. */
    text: string
    /** Does the copying. Called only after "Copy anyway", once per confirmation, with `text` as it was when the button was clicked. */
    onCopy: (text: string) => void
    className?: string
    children: ReactNode
}

type Ask = (text: string, onCopy: (text: string) => void) => void
const AskContext = createContext<Ask | null>(null)

/**
 * Holds the one warning a list of raw values can show. The state belongs to the list and not to the row that was clicked: a row of a
 * virtualised, live list is removed or re-used for the next event within a second on a fast stream, and a warning kept in the row closed itself
 * before it could be confirmed (found on the deployed site) and could have copied the text of a different event. What is asked about is the text
 * as it was when the button was clicked.
 */
export function RawCopyProvider({ theme, children }: { theme: Theme; children: ReactNode }) {
    const [pending, setPending] = useState<{ text: string; onCopy: (text: string) => void } | null>(null)
    const ask = useCallback<Ask>((text, onCopy) => setPending({ text, onCopy }), [])
    return (
        <AskContext.Provider value={ask}>
            {children}
            {pending && createPortal(
                <RawCopyDialog theme={theme} onCancel={() => setPending(null)} onConfirm={() => { const { text, onCopy } = pending; setPending(null); onCopy(text) }} />,
                document.body,
            )}
        </AskContext.Provider>
    )
}

/**
 * A Copy button for a raw recorded value. The click asks first (Q19): the value is shown as received and may hold secrets. Every copy
 * asks again; nothing is remembered, and nothing is guessed about which values are sensitive. The dialog is drawn on the page itself, not
 * inside whatever the button sits in, so a transformed or scrolling row cannot trap or clip it. Inside a `RawCopyProvider` the warning belongs to the
 * list and outlives the row; on its own (a lone button) it keeps its own.
 */
export function RawCopyButton({ theme, text, onCopy, className, children }: Props) {
    const ask = useContext(AskContext)
    const [asking, setAsking] = useState<string | null>(null)
    return (
        <>
            <button type="button" onClick={() => (ask ? ask(text, onCopy) : setAsking(text))} aria-haspopup="dialog" className={className}>{children}</button>
            {asking !== null && createPortal(
                <RawCopyDialog theme={theme} onCancel={() => setAsking(null)} onConfirm={() => { const value = asking; setAsking(null); onCopy(value) }} />,
                document.body,
            )}
        </>
    )
}
