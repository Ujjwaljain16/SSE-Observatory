import { useState } from 'react'
import type { Theme } from '../../types'
import { deleteAllCaptures, pruneOlderThan } from '../../doctor/captureLibrary'
import { RETENTION_CHOICES, libraryRetentionDays, recordingEnabled, setLibraryRetentionDays, setRecordingEnabled } from '../../doctor/recordingConfig'

interface Props {
    theme: Theme
    /** How many captures are saved, as the list above shows them. */
    count: number
    /** The library changed (something was deleted), so the list above should be read again. */
    onChanged: () => void
}

const label = (days: number) => (days === 0 ? 'Until I delete them' : days === 1 ? 'After 1 day' : `After ${days} days`)

/** What the app keeps and for how long: the recording, the saved captures, and how to get rid of them. */
export default function PrivacySettings({ theme, count, onChanged }: Props) {
    const dark = theme === 'dark'
    const muted = dark ? 'text-slate-300' : 'text-slate-700'
    const strong = dark ? 'text-white' : 'text-slate-900'
    const button = `px-3 py-1.5 rounded-lg text-sm font-medium disabled:opacity-50 ${dark ? 'bg-slate-700 text-slate-100 hover:bg-slate-600' : 'bg-slate-200 text-slate-900 hover:bg-slate-300'}`
    const field = `rounded-lg border px-2 py-1 text-sm ${dark ? 'bg-slate-800 border-slate-600 text-white' : 'bg-white border-slate-300 text-slate-900'}`

    const [recording, setRecording] = useState(recordingEnabled)
    const [days, setDays] = useState(libraryRetentionDays)
    const [confirming, setConfirming] = useState(false)
    const [notice, setNotice] = useState('')

    const changeDays = async (value: number) => {
        setDays(value)
        setLibraryRetentionDays(value)
        try {
            const gone = await pruneOlderThan(value)
            setNotice(gone > 0 ? `Deleted ${gone} saved capture${gone === 1 ? '' : 's'} older than ${value} day${value === 1 ? '' : 's'}.` : '')
            if (gone > 0) onChanged()
        } catch { setNotice('The saved captures could not be read, so none were deleted.') }
    }
    const deleteAll = async () => {
        setConfirming(false)
        try {
            const gone = await deleteAllCaptures()
            setNotice(`Deleted ${gone} saved capture${gone === 1 ? '' : 's'}.`)
            onChanged()
        } catch { setNotice('The saved captures could not be deleted.') }
    }

    return (
        <section aria-label="Privacy and retention" className="space-y-3" data-testid="privacy-settings">
            <h3 className={`text-sm font-semibold ${strong}`}>Privacy and retention</h3>
            <ul className={`list-disc pl-5 text-sm space-y-1 ${muted}`}>
                <li><strong className={strong}>The live recording</strong> is held in this tab's memory, up to 8 MB per stream (older detail is folded away, never silently), and is gone when the tab closes.</li>
                <li><strong className={strong}>Saved captures</strong> are in this browser's storage, not redacted, until you delete them or the time below passes. Their bookmarks go with them.</li>
                <li><strong className={strong}>Your profile and redaction rules</strong> are in this browser's local storage.</li>
                <li>Nothing is uploaded, except when you replay a redacted capture in Mock mode: it is sent to this app's own server for the replay.</li>
            </ul>

            <label className={`flex items-start gap-2 text-sm ${strong}`}>
                <input type="checkbox" checked={recording} onChange={(e) => { setRecording(e.target.checked); setRecordingEnabled(e.target.checked) }} className="mt-1" data-testid="privacy-recording" />
                <span>
                    Record what the Doctor reads
                    <span className={`block text-xs ${muted}`}>Turn off to keep nothing for diagnosis: the viewer works as before, and the Doctor shows nothing. It applies to streams started after the change.</span>
                </span>
            </label>

            <label className={`flex flex-wrap items-center gap-2 text-sm ${strong}`}>
                Delete saved captures
                <select value={days} onChange={(e) => void changeDays(Number(e.target.value))} className={field} data-testid="privacy-retention">
                    {RETENTION_CHOICES.map((d) => <option key={d} value={d}>{label(d)}</option>)}
                </select>
                <span className={`text-xs ${muted}`}>Counted from when a capture was saved. Checked when the app starts and when you change this.</span>
            </label>

            <div className="flex flex-wrap items-center gap-3">
                {!confirming ? (
                    <button type="button" className={button} disabled={count === 0} onClick={() => setConfirming(true)} data-testid="privacy-delete-all">
                        Delete all saved captures ({count})
                    </button>
                ) : (
                    <>
                        <span className={`text-sm ${strong}`}>Delete {count} saved capture{count === 1 ? '' : 's'} and their bookmarks? This cannot be undone.</span>
                        <button type="button" className="px-3 py-1.5 rounded-lg text-sm font-medium bg-red-700 text-white hover:bg-red-600" onClick={() => void deleteAll()} data-testid="privacy-delete-confirm">Yes, delete them</button>
                        <button type="button" className={button} onClick={() => setConfirming(false)}>Keep them</button>
                    </>
                )}
            </div>
            <p role="status" className={`text-sm ${strong}`} data-testid="privacy-notice">{notice}</p>
        </section>
    )
}
