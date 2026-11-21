import { useRef, useState } from 'react'
import { describe, expect, it } from 'vitest'
import { fireEvent, render, screen } from '@testing-library/react'
import { useModalFocus } from '../useModalFocus'

function Dialog({ onClose }: { onClose: () => void }) {
    const ref = useRef<HTMLDivElement>(null)
    useModalFocus(ref, true, onClose)
    return <div ref={ref} role="dialog" tabIndex={-1}><button type="button">Inside</button></div>
}

function Page() {
    const [open, setOpen] = useState(false)
    return (
        <div>
            <button type="button" onClick={() => setOpen(true)}>Open</button>
            {open && <Dialog onClose={() => setOpen(false)} />}
        </div>
    )
}

describe('useModalFocus: focus goes back to the control that opened the dialog', () => {
    it('after a keyboard open, where the button had focus', () => {
        render(<Page />)
        const open = screen.getByRole('button', { name: 'Open' })
        open.focus()
        fireEvent.click(open)
        expect(screen.getByRole('button', { name: 'Inside' })).toHaveFocus()
        fireEvent.keyDown(document, { key: 'Escape' })
        expect(open).toHaveFocus()
    })

    // Safari and Firefox on macOS do not give a button focus when it is clicked: the click lands with the page body as the active element.
    it('after a click that did not focus the button (Safari), too', () => {
        render(<Page />)
        const open = screen.getByRole('button', { name: 'Open' })
        expect(document.body).toHaveFocus()
        fireEvent.click(open) // fireEvent.click does not move focus, as in Safari
        expect(screen.getByRole('button', { name: 'Inside' })).toHaveFocus()
        fireEvent.keyDown(document, { key: 'Escape' })
        expect(open).toHaveFocus()
    })
})
