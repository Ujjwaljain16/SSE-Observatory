import { useId, useRef, type KeyboardEvent, type ReactNode } from 'react'
import type { Theme } from '../../types'

export interface TabSpec {
    id: string
    label: string
    /** A short count or mark after the label, read out with it. */
    badge?: string | undefined
}

interface Props {
    theme: Theme
    label: string
    tabs: TabSpec[]
    active: string
    onChange: (id: string) => void
    children: ReactNode
}

/** Tabs the way assistive technology expects them: one tab stop, arrow keys between tabs, Home and End, a labelled panel. */
export function Tabs({ theme, label, tabs, active, onChange, children }: Props) {
    const dark = theme === 'dark'
    const base = useId()
    const refs = useRef(new Map<string, HTMLButtonElement>())

    const move = (index: number) => {
        const next = tabs[(index + tabs.length) % tabs.length]!
        onChange(next.id)
        refs.current.get(next.id)?.focus()
    }
    const onKeyDown = (e: KeyboardEvent, index: number) => {
        if (e.key === 'ArrowRight') { e.preventDefault(); move(index + 1) }
        else if (e.key === 'ArrowLeft') { e.preventDefault(); move(index - 1) }
        else if (e.key === 'Home') { e.preventDefault(); move(0) }
        else if (e.key === 'End') { e.preventDefault(); move(tabs.length - 1) }
    }

    return (
        <div>
            <div role="tablist" aria-label={label} className={`flex flex-wrap gap-1 border-b mb-4 ${dark ? 'border-slate-700' : 'border-slate-200'}`}>
                {tabs.map((tab, i) => {
                    const selected = tab.id === active
                    return (
                        <button
                            key={tab.id}
                            ref={(el) => { if (el) refs.current.set(tab.id, el); else refs.current.delete(tab.id) }}
                            type="button"
                            role="tab"
                            id={`${base}-tab-${tab.id}`}
                            aria-selected={selected}
                            aria-controls={`${base}-panel-${tab.id}`}
                            tabIndex={selected ? 0 : -1}
                            onClick={() => onChange(tab.id)}
                            onKeyDown={(e) => onKeyDown(e, i)}
                            data-testid={`doctor-tab-${tab.id}`}
                            className={`px-4 py-2 text-sm font-medium rounded-t-lg border-b-2 -mb-px ${selected
                                ? (dark ? 'border-teal-400 text-white' : 'border-teal-700 text-slate-900')
                                : (dark ? 'border-transparent text-slate-300 hover:text-white' : 'border-transparent text-slate-700 hover:text-slate-900')}`}
                        >
                            {tab.label}{tab.badge ? <span className={`ml-2 px-1.5 py-0.5 rounded-full text-xs font-bold ${dark ? 'bg-slate-700 text-slate-100' : 'bg-slate-200 text-slate-900'}`}>{tab.badge}</span> : null}
                        </button>
                    )
                })}
            </div>
            <div role="tabpanel" id={`${base}-panel-${active}`} aria-labelledby={`${base}-tab-${active}`} tabIndex={0} className="outline-none focus-visible:ring-2 focus-visible:ring-teal-500 rounded">
                {children}
            </div>
        </div>
    )
}
