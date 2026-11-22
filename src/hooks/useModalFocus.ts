import { useEffect, useRef, type RefObject } from 'react'

const FOCUSABLE = 'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'

// Safari (and Firefox on macOS) do not focus a button when it is clicked, so when a dialog opens from a click the page body is the active element and
// there is nothing to give focus back to. The control that was last clicked stands in for it.
let lastClicked: HTMLElement | null = null
if (typeof document !== 'undefined') {
    document.addEventListener('click', (e) => {
        lastClicked = e.target instanceof Element ? e.target.closest<HTMLElement>('button, a[href], [role="button"], input, select, textarea') : null
    }, true)
}

/**
 * Keyboard behaviour for a modal dialog: Escape closes it, Tab stays inside it, focus moves in on open and goes
 * back to whatever had it before on close.
 */
export function useModalFocus(containerRef: RefObject<HTMLElement | null>, active: boolean, onClose: () => void) {
    const closeRef = useRef(onClose)
    closeRef.current = onClose

    useEffect(() => {
        if (!active) return
        const container = containerRef.current
        if (!container) return
        const focused = document.activeElement as HTMLElement | null
        const previous = focused && focused !== document.body ? focused : lastClicked
        const focusables = () => [...container.querySelectorAll<HTMLElement>(FOCUSABLE)]

        if (!container.contains(document.activeElement)) (focusables()[0] ?? container).focus()

        const onKeyDown = (e: KeyboardEvent) => {
            if (e.key === 'Escape') {
                e.stopPropagation()
                closeRef.current()
                return
            }
            if (e.key !== 'Tab') return
            const items = focusables()
            if (items.length === 0) { e.preventDefault(); container.focus(); return }
            const first = items[0]
            const last = items[items.length - 1]
            const current = document.activeElement
            if (e.shiftKey && (current === first || !container.contains(current))) { e.preventDefault(); last.focus() }
            else if (!e.shiftKey && (current === last || !container.contains(current))) { e.preventDefault(); first.focus() }
        }
        document.addEventListener('keydown', onKeyDown)
        return () => {
            document.removeEventListener('keydown', onKeyDown)
            if (previous && document.contains(previous)) previous.focus()
        }
    }, [containerRef, active])
}
