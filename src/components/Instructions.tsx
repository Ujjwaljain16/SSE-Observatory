import type { Theme } from '../types'
import { ClipboardList } from 'lucide-react'

interface InstructionsProps {
    theme: Theme
}

export const Instructions = ({ theme }: InstructionsProps) => {
    return (
        <div className={`rounded-xl p-5 mb-8 border animate-fade-in ${theme === 'dark'
            ? 'bg-sky-900/10 border-sky-800/30'
            : 'bg-sky-50 border-sky-200'
            }`}>
            <h3 className={`font-semibold mb-3 flex items-center gap-2 ${theme === 'dark' ? 'text-sky-300' : 'text-sky-900'}`}>
                <ClipboardList className="w-5 h-5" /> How to use:
            </h3>
            <ol className={`text-sm space-y-2 list-decimal list-inside ml-1 ${theme === 'dark' ? 'text-sky-200/80' : 'text-sky-800'
                }`}>
                <li>Enter the SSE endpoint URL</li>
                <li>Paste the Bearer token (optional)</li>
                <li>Save a profile to reuse later</li>
                <li>Click "Connect" to start monitoring</li>
            </ol>
        </div>
    )
}
