import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import RedactionRules from '../doctor/RedactionRules'
import PrivacySettings from '../doctor/PrivacySettings'
import { getRedactionPolicy, setRedactionPolicy } from '../../doctor/redactionPolicyStore'
import { listCaptures, resetLibrary, saveCapture } from '../../doctor/captureLibrary'
import { libraryRetentionDays, recordingEnabled } from '../../doctor/recordingConfig'

async function wipe() {
    resetLibrary()
    await new Promise<void>((resolve) => {
        const req = indexedDB.deleteDatabase('sse-doctor-db')
        req.onsuccess = () => resolve()
        req.onerror = () => resolve()
        req.onblocked = () => resolve()
    })
    resetLibrary()
}
beforeEach(async () => { localStorage.clear(); setRedactionPolicy(undefined); await wipe() })
afterEach(async () => { vi.useRealTimers(); await wipe() })

const rules = (text: string) => JSON.stringify({ version: 1, extraKeys: ['ssn'], extraPatterns: [{ name: 'ticket', pattern: 'ACME-\\d{6}' }] }) + text

describe('RedactionRules', () => {
    const open = async () => { await userEvent.click(screen.getByText(/Redaction rules/)) }

    it('says the built-in rules apply alone when there is no policy', () => {
        render(<RedactionRules theme="dark" policy={undefined} onChange={() => {}} />)
        expect(screen.getByTestId('redaction-rules-summary')).toHaveTextContent('built-in rules only')
    })

    it('saves rules that are valid, tells the caller, and says so', async () => {
        const onChange = vi.fn()
        render(<RedactionRules theme="light" policy={undefined} onChange={onChange} />)
        await open()
        const box = screen.getByTestId('redaction-rules-text')
        await userEvent.click(box)
        await userEvent.paste(rules(''))
        await userEvent.click(screen.getByTestId('redaction-rules-apply'))
        expect(onChange).toHaveBeenCalledWith({ extraKeys: ['ssn'], extraPatterns: [{ name: 'ticket', pattern: 'ACME-\\d{6}' }] })
        expect(getRedactionPolicy()?.extraKeys).toEqual(['ssn'])
        expect(screen.getByTestId('redaction-rules-saved')).toBeInTheDocument()
        expect(screen.queryByTestId('redaction-rules-errors')).toBeNull()
    })

    it('lists every problem, saves nothing, and leaves the earlier rules in place', async () => {
        setRedactionPolicy({ extraKeys: ['earlier'] })
        const onChange = vi.fn()
        render(<RedactionRules theme="dark" policy={{ extraKeys: ['earlier'] }} onChange={onChange} />)
        await open()
        const box = screen.getByTestId('redaction-rules-text')
        await userEvent.clear(box)
        await userEvent.click(box)
        await userEvent.paste(JSON.stringify({ keepHeaders: ['Cookie'], nope: 1 }))
        await userEvent.click(screen.getByTestId('redaction-rules-apply'))
        const errors = screen.getByTestId('redaction-rules-errors')
        expect(errors).toHaveTextContent('not saved')
        expect(errors).toHaveTextContent('"Cookie" carries credentials')
        expect(errors).toHaveTextContent('Unknown field "nope"')
        expect(onChange).not.toHaveBeenCalled()
        expect(getRedactionPolicy()).toEqual({ extraKeys: ['earlier'] })
    })

    it('removes the rules, and offers an example that is itself a valid policy', async () => {
        setRedactionPolicy({ extraKeys: ['a'] })
        const onChange = vi.fn()
        render(<RedactionRules theme="dark" policy={{ extraKeys: ['a'] }} onChange={onChange} />)
        await open()
        await userEvent.click(screen.getByRole('button', { name: 'Insert an example' }))
        await userEvent.click(screen.getByTestId('redaction-rules-apply'))
        expect(screen.queryByTestId('redaction-rules-errors')).toBeNull()
        expect(getRedactionPolicy()?.extraPatterns?.[0]?.name).toBe('ticket')

        await userEvent.click(screen.getByTestId('redaction-rules-clear'))
        expect(onChange).toHaveBeenLastCalledWith(undefined)
        expect(getRedactionPolicy()).toBeUndefined()
        expect(screen.getByTestId('redaction-rules-text')).toHaveValue('')
    })
})

describe('PrivacySettings', () => {
    const save = (name: string) => saveCapture({ name, text: '{"format":"sse-capture"}\n', records: 1, origin: 'recording' })

    it('turns recording off and on, and remembers it', async () => {
        render(<PrivacySettings theme="dark" count={0} onChanged={() => {}} />)
        const box = screen.getByTestId('privacy-recording')
        expect(box).toBeChecked()
        await userEvent.click(box)
        expect(recordingEnabled()).toBe(false)
        await userEvent.click(box)
        expect(recordingEnabled()).toBe(true)
    })

    it('saves the retention choice and deletes what is older at once, saying how many', async () => {
        vi.useFakeTimers({ toFake: ['Date'], now: Date.now() - 40 * 86_400_000 })
        await save('old')
        vi.useRealTimers()
        await save('fresh')
        const onChanged = vi.fn()
        render(<PrivacySettings theme="light" count={1} onChanged={onChanged} />)
        await userEvent.selectOptions(screen.getByTestId('privacy-retention'), '30')
        expect(libraryRetentionDays()).toBe(30)
        await waitFor(() => expect(screen.getByTestId('privacy-notice')).toHaveTextContent('Deleted 1 saved capture older than 30 days.'))
        expect((await listCaptures()).map((c) => c.name)).toEqual(['fresh'])
        expect(onChanged).toHaveBeenCalled()
    })

    it('asks before deleting everything, and a second click does it', async () => {
        await save('a')
        await save('b')
        const onChanged = vi.fn()
        render(<PrivacySettings theme="dark" count={2} onChanged={onChanged} />)
        const del = screen.getByRole('button', { name: /Delete all saved captures \(2\)/ })
        await userEvent.click(del)
        expect(await listCaptures()).toHaveLength(2) // asked, not done
        await userEvent.click(screen.getByRole('button', { name: 'Keep them' }))
        expect(await listCaptures()).toHaveLength(2)

        await userEvent.click(screen.getByRole('button', { name: /Delete all saved captures/ }))
        await userEvent.click(screen.getByTestId('privacy-delete-confirm'))
        await waitFor(() => expect(screen.getByTestId('privacy-notice')).toHaveTextContent('Deleted 2 saved captures.'))
        expect(await listCaptures()).toHaveLength(0)
        expect(onChanged).toHaveBeenCalled()
    })
})
