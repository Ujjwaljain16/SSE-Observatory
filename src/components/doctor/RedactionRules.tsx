import { useState } from 'react'
import type { Theme } from '../../types'
import { describePolicy, parseRedactionPolicy, POLICY_LIMITS } from '../../core/capture/policy'
import type { RedactionPolicy } from '../../core/capture/redact'
import { getRedactionPolicyText, setRedactionPolicy } from '../../doctor/redactionPolicyStore'

interface Props {
    theme: Theme
    policy: RedactionPolicy | undefined
    /** Called with the policy that is now saved (undefined when cleared). */
    onChange: (policy: RedactionPolicy | undefined) => void
}

const EXAMPLE = `{
  "version": 1,
  "extraKeys": ["ssn", "internalNote"],
  "extraPatterns": [{ "name": "ticket", "pattern": "ACME-\\\\d{6}", "flags": "i" }],
  "keepHeaders": ["x-request-id"]
}`

/** Edit the redaction rules as JSON: the same file the command line reads with --redact-policy. */
export default function RedactionRules({ theme, policy, onChange }: Props) {
    const dark = theme === 'dark'
    const muted = dark ? 'text-slate-300' : 'text-slate-700'
    const strong = dark ? 'text-white' : 'text-slate-900'
    const [text, setText] = useState(getRedactionPolicyText)
    const [errors, setErrors] = useState<string[]>([])
    const [saved, setSaved] = useState(false)

    const apply = () => {
        const checked = parseRedactionPolicy(text)
        setSaved(false)
        if (checked.errors.length > 0) { setErrors(checked.errors); return }
        setErrors([])
        setRedactionPolicy(checked.policy)
        onChange(checked.policy)
        setSaved(true)
    }
    const clear = () => {
        setText('')
        setErrors([])
        setRedactionPolicy(undefined)
        onChange(undefined)
        setSaved(true)
    }

    return (
        <details data-testid="redaction-rules" className={`rounded-lg border px-3 py-2 ${dark ? 'border-slate-700' : 'border-slate-200'}`}>
            <summary className={`cursor-pointer text-sm font-semibold ${strong}`}>
                Redaction rules <span className={`font-normal ${muted}`} data-testid="redaction-rules-summary">(built-in rules{policy ? ` plus ${describePolicy(policy)}` : ' only'})</span>
            </summary>
            <div className="mt-3 space-y-3">
                <p className={`text-sm ${muted}`}>
                    Add your own on top of the built-in rules: payload key names to treat as secret, patterns to replace (a regular expression; the whole match, or the
                    first group, is replaced), and request headers whose value may stay. Rules can only add to redaction. A header that carries credentials cannot be kept.
                    Limits: {POLICY_LIMITS.keys} key names, {POLICY_LIMITS.patterns} patterns of up to {POLICY_LIMITS.patternLength} characters. Saved in this browser; the
                    command line reads the same text from a file with <code>--redact-policy</code>.
                </p>
                <label className={`block text-sm ${strong}`}>
                    <span className="block mb-1">Rules (JSON)</span>
                    <textarea
                        value={text}
                        onChange={(e) => { setText(e.target.value); setSaved(false) }}
                        rows={8}
                        spellCheck={false}
                        data-testid="redaction-rules-text"
                        className={`w-full font-mono text-xs rounded-lg border p-2 ${dark ? 'bg-slate-950 border-slate-600 text-slate-100' : 'bg-white border-slate-300 text-slate-900'}`}
                    />
                </label>
                {errors.length > 0 && (
                    <div role="alert" data-testid="redaction-rules-errors" className={`text-sm rounded-lg p-3 ${dark ? 'bg-red-900/40 text-red-100' : 'bg-red-50 text-red-900'}`}>
                        <p className="font-semibold">These rules were not saved. Nothing changed.</p>
                        <ul className="list-disc pl-5 mt-1">{errors.map((e, i) => <li key={i}>{e}</li>)}</ul>
                    </div>
                )}
                {saved && <p role="status" className={`text-sm ${dark ? 'text-emerald-300' : 'text-emerald-800'}`} data-testid="redaction-rules-saved">Saved. Exports use these rules from now on.</p>}
                <div className="flex flex-wrap gap-2">
                    <button type="button" onClick={apply} data-testid="redaction-rules-apply" className="px-3 py-1.5 rounded-lg text-sm font-medium bg-teal-700 text-white hover:bg-teal-600">Save rules</button>
                    <button type="button" onClick={() => { setText(EXAMPLE); setErrors([]); setSaved(false) }} className={`px-3 py-1.5 rounded-lg text-sm ${dark ? 'bg-slate-700 text-slate-100 hover:bg-slate-600' : 'bg-slate-200 text-slate-900 hover:bg-slate-300'}`}>Insert an example</button>
                    <button type="button" onClick={clear} data-testid="redaction-rules-clear" className={`px-3 py-1.5 rounded-lg text-sm ${dark ? 'bg-slate-700 text-slate-100 hover:bg-slate-600' : 'bg-slate-200 text-slate-900 hover:bg-slate-300'}`}>Remove my rules</button>
                </div>
            </div>
        </details>
    )
}
