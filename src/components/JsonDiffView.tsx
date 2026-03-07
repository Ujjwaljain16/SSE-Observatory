import diff from 'microdiff'
import type { Theme } from '../types'

interface JsonDiffViewProps {
    oldData: any;
    newData: any;
    theme: Theme;
}

export const JsonDiffView = ({ oldData, newData, theme }: JsonDiffViewProps) => {
    const isDark = theme === 'dark'

    // Safety check just in case
    const safeOld = typeof oldData === 'object' && oldData !== null ? oldData : {}
    const safeNew = typeof newData === 'object' && newData !== null ? newData : {}

    // Using microdiff
    const differences = diff(safeOld, safeNew)

    if (differences.length === 0) {
        return (
            <div className={`p-4 rounded-lg text-sm text-center font-medium ${isDark ? 'bg-slate-800/80 text-slate-400 border border-slate-700/50' : 'bg-slate-50 text-slate-500 border border-slate-200'}`}>
                No differences found between the selected events.
            </div>
        )
    }

    return (
        <div className={`rounded-lg overflow-hidden border shadow-sm ${isDark ? 'bg-slate-900 border-slate-700' : 'bg-white border-slate-200'}`}>
            <div className={`px-4 py-2.5 text-xs font-semibold flex items-center justify-between ${isDark ? 'bg-slate-800 border-b border-slate-700 text-slate-300' : 'bg-slate-50 border-b border-slate-200 text-slate-700'}`}>
                <span>Differences Detected</span>
                <span className={`px-2 py-0.5 rounded-md ${isDark ? 'bg-slate-700 text-slate-400' : 'bg-slate-200 text-slate-600'}`}>{differences.length} changes</span>
            </div>
            <div className="p-4 font-mono text-xs overflow-x-auto space-y-2">
                {differences.map((d, i) => {
                    const pathStr = d.path.join('.')

                    if (d.type === 'CREATE') {
                        return (
                            <div key={i} className={`flex gap-3 p-2 rounded-lg ${isDark ? 'bg-emerald-500/10 text-emerald-400' : 'bg-emerald-50 text-emerald-700'}`}>
                                <span className="opacity-50 select-none w-4 font-bold">+</span>
                                <span><span className="font-semibold">{pathStr}:</span> {JSON.stringify(d.value)}</span>
                            </div>
                        )
                    }
                    if (d.type === 'REMOVE') {
                        return (
                            <div key={i} className={`flex gap-3 p-2 rounded-lg ${isDark ? 'bg-rose-500/10 text-rose-400' : 'bg-rose-50 text-rose-700'}`}>
                                <span className="opacity-50 select-none w-4 font-bold">-</span>
                                <span><span className="font-semibold">{pathStr}:</span> <del className="opacity-70">{JSON.stringify((d as any).oldValue)}</del></span>
                            </div>
                        )
                    }
                    if (d.type === 'CHANGE') {
                        return (
                            <div key={i} className={`flex flex-col gap-1.5 p-2 rounded-lg ${isDark ? 'bg-amber-500/10 text-amber-400' : 'bg-amber-50 text-amber-700'}`}>
                                <div className="flex gap-3">
                                    <span className="opacity-50 select-none w-4 font-bold">-</span>
                                    <span><span className="font-semibold">{pathStr}:</span> <del className="opacity-70">{JSON.stringify(d.oldValue)}</del></span>
                                </div>
                                <div className="flex gap-3">
                                    <span className="opacity-50 select-none w-4 font-bold">+</span>
                                    <span><span className="font-semibold">{pathStr}:</span> {JSON.stringify(d.value)}</span>
                                </div>
                            </div>
                        )
                    }
                    return null
                })}
            </div>
        </div>
    )
}
