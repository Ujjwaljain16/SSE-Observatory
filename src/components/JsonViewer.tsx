import { memo, useMemo, useState } from 'react'
import { ChevronDown, ChevronRight } from 'lucide-react'
import type { Theme } from '../types'
import { childrenOf, leafText, shapeOf, summarise, tokenizeJson, MAX_HIGHLIGHT_CHARS, type JsonTokenKind } from '../utils/jsonView'

// Every colour is at least 4.5:1 on the row background in its theme (the axe checks in e2e/a11y.spec.ts run on this).
const COLOURS: Record<Theme, Record<JsonTokenKind, string>> = {
    dark: { key: 'text-sky-300', string: 'text-emerald-300', number: 'text-amber-300', literal: 'text-violet-300', punct: 'text-slate-400', space: '', text: 'text-slate-300' },
    light: { key: 'text-sky-800', string: 'text-emerald-800', number: 'text-amber-800', literal: 'text-violet-800', punct: 'text-slate-600', space: '', text: 'text-slate-700' },
}

/** Pretty-printed JSON with syntax colours. Long text is shown plain (see MAX_HIGHLIGHT_CHARS). The text itself is unchanged. */
export const HighlightedJson = memo(function HighlightedJson({ text, theme }: { text: string; theme: Theme }) {
    const tokens = useMemo(() => (text.length > MAX_HIGHLIGHT_CHARS ? null : tokenizeJson(text)), [text])
    const colours = COLOURS[theme]
    return (
        <pre data-testid="json-highlighted" className="whitespace-pre-wrap break-words text-xs leading-relaxed">
            {tokens === null
                ? <span className={colours.text}>{text}</span>
                : tokens.map((t, i) => (t.kind === 'space' ? t.text : <span key={i} className={colours[t.kind]}>{t.text}</span>))}
        </pre>
    )
})

const CHUNK = 100

function TreeNode({ name, value, depth, theme }: { name: string | undefined; value: unknown; depth: number; theme: Theme }) {
    const colours = COLOURS[theme]
    const summary = summarise(value)
    const [open, setOpen] = useState(depth < 2)
    const [limit, setLimit] = useState(CHUNK)
    const label = name !== undefined ? <><span className={colours.key}>{name}</span><span className={colours.punct}>: </span></> : null

    if (summary === undefined) {
        const shape = shapeOf(value)
        const cls = shape === 'string' ? colours.string : shape === 'number' ? colours.number : colours.literal
        return <li className="py-px break-words">{label}<span className={cls}>{leafText(value)}</span></li>
    }

    const kids = open ? childrenOf(value) : []
    return (
        <li className="py-px">
            <button
                type="button"
                aria-expanded={open}
                onClick={() => setOpen(!open)}
                className="inline-flex items-center gap-1 rounded text-left focus-visible:outline focus-visible:outline-2 focus-visible:outline-sky-500"
            >
                {open ? <ChevronDown className="w-3 h-3 shrink-0" aria-hidden="true" /> : <ChevronRight className="w-3 h-3 shrink-0" aria-hidden="true" />}
                {label}
                <span className={colours.punct}>{summary}</span>
            </button>
            {open && (
                <ul className="ml-4 border-l border-slate-500/30 pl-2">
                    {kids.slice(0, limit).map(([k, v]) => <TreeNode key={k} name={k} value={v} depth={depth + 1} theme={theme} />)}
                    {kids.length > limit && (
                        <li>
                            <button type="button" onClick={() => setLimit(limit + CHUNK)} className={`text-xs underline ${colours.punct}`}>
                                Show {Math.min(CHUNK, kids.length - limit)} more of {kids.length - limit} not shown
                            </button>
                        </li>
                    )}
                </ul>
            )}
        </li>
    )
}

/** A collapsible tree of a parsed payload: the first two levels open, the rest a click away, long lists shown in pages. */
export const JsonTree = memo(function JsonTree({ value, theme }: { value: unknown; theme: Theme }) {
    return (
        <ul data-testid="json-tree" className="text-xs leading-relaxed font-mono">
            <TreeNode name={undefined} value={value} depth={0} theme={theme} />
        </ul>
    )
})
