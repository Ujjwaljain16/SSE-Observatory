import { useRef } from 'react'
import type { Theme } from '../types'
import { RAW_COPY_CANCEL, RAW_COPY_CONFIRM, RAW_COPY_TITLE, RAW_COPY_WARNING } from '../utils/rawValues'
import { useModalFocus } from '../hooks/useModalFocus'

interface Props {
    theme: Theme
    /** Copies exactly the value that was asked for. */
    onConfirm: () => void
    /** Copies nothing. Also what Escape and a click outside do. */
    onCancel: () => void
}

/**
 * The step before a raw recorded value goes to the clipboard. A modal dialog the way the others are: it takes focus (on Cancel, the safe
 * choice), keeps Tab inside, closes on Escape and gives focus back to the button that opened it.
 */
export function RawCopyDialog({ theme, onConfirm, onCancel }: Props) {
    const dark = theme === 'dark'
    const dialogRef = useRef<HTMLDivElement>(null)
    useModalFocus(dialogRef, true, onCancel)
    return (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4" onClick={onCancel}>
            <div className="absolute inset-0 bg-black/60" />
            <div
                ref={dialogRef}
                role="alertdialog"
                aria-modal="true"
                aria-labelledby="raw-copy-title"
                aria-describedby="raw-copy-warning"
                tabIndex={-1}
                data-testid="raw-copy-dialog"
                className={`relative w-full max-w-md rounded-xl shadow-2xl border p-5 space-y-4 outline-none ${dark ? 'bg-slate-900 border-slate-700' : 'bg-white border-slate-200'}`}
                onClick={(e) => e.stopPropagation()}
            >
                <h2 id="raw-copy-title" className={`text-lg font-bold ${dark ? 'text-white' : 'text-slate-900'}`}>{RAW_COPY_TITLE}</h2>
                <p id="raw-copy-warning" className={`text-sm ${dark ? 'text-slate-200' : 'text-slate-800'}`}>{RAW_COPY_WARNING}</p>
                <div className="flex justify-end gap-2">
                    <button type="button" onClick={onCancel} data-testid="raw-copy-cancel" className={`px-3 py-1.5 rounded-lg text-sm font-medium ${dark ? 'bg-slate-700 text-slate-100 hover:bg-slate-600' : 'bg-slate-200 text-slate-900 hover:bg-slate-300'}`}>{RAW_COPY_CANCEL}</button>
                    <button type="button" onClick={onConfirm} data-testid="raw-copy-confirm" className={`px-3 py-1.5 rounded-lg text-sm font-medium ${dark ? 'bg-amber-300 text-slate-900 hover:bg-amber-200' : 'bg-amber-700 text-white hover:bg-amber-800'}`}>{RAW_COPY_CONFIRM}</button>
                </div>
            </div>
        </div>
    )
}
