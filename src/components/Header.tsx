import type { Theme } from '../types'
import { Activity, Sun, Moon, Github } from 'lucide-react'

interface HeaderProps {
    theme: Theme
    onToggleTheme: () => void
}

export const Header = ({ theme, onToggleTheme }: HeaderProps) => {
    return (
        <div className="flex items-center justify-between mb-10 animate-fade-in">
            <div className="relative">
                {/* Decorative glow */}
                <div className="absolute -inset-4 bg-gradient-to-r from-sky-600/20 via-blue-600/20 to-cyan-600/20 blur-3xl opacity-60 -z-10" />

                <div className="flex items-center gap-4">
                    {/* Animated Logo */}
                    <div className={`
                        w-16 h-16 rounded-2xl flex items-center justify-center
                        bg-gradient-to-br from-sky-500 via-blue-500 to-cyan-500
                        shadow-lg shadow-blue-500/30 hover:shadow-blue-500/50
                        transition-all duration-300 hover:scale-105 hover:rotate-3
                    `}>
                        <Activity className="w-8 h-8 text-white" />
                    </div>

                    <div>
                        <h1 className={`
                            text-4xl md:text-5xl font-extrabold tracking-tight
                            bg-gradient-to-r from-sky-400 via-blue-400 to-cyan-400
                            bg-clip-text text-transparent
                            drop-shadow-sm
                        `}>
                            SSE Observatory
                        </h1>
                        <p className={`text-base mt-1 flex items-center gap-2 ${theme === 'dark' ? 'text-slate-400' : 'text-slate-600'
                            }`}>
                            <span className="live-dot" />
                            Real-time event monitoring & debugging
                        </p>
                    </div>
                </div>
            </div>

            <div className="flex items-center gap-3">
                {/* GitHub Link */}
                <a
                    href="https://github.com"
                    target="_blank"
                    rel="noopener noreferrer"
                    className={`
                        p-3 rounded-xl transition-all duration-300 hover:scale-105
                        ${theme === 'dark'
                            ? 'bg-slate-800/50 hover:bg-slate-700/70 text-slate-400 hover:text-white border border-slate-700/50'
                            : 'bg-slate-100 hover:bg-slate-200 text-slate-600 hover:text-slate-900 border border-slate-200'
                        }
                    `}
                >
                    <Github className="w-5 h-5" />
                </a>

                {/* Theme Toggle */}
                <button
                    onClick={onToggleTheme}
                    className={`
                        px-5 py-3 rounded-xl font-semibold transition-all duration-300
                        flex items-center gap-2 hover:scale-105 group
                        ${theme === 'dark'
                            ? 'bg-gradient-to-r from-amber-400 to-orange-400 text-slate-900 shadow-lg shadow-amber-500/30 hover:shadow-amber-500/50'
                            : 'bg-gradient-to-r from-slate-700 to-slate-900 text-white shadow-lg shadow-slate-800/30 hover:shadow-slate-800/50'
                        }
                    `}
                >
                    <span className="text-xl transition-transform duration-300 group-hover:rotate-12">
                        {theme === 'dark' ? <Sun className="w-5 h-5" /> : <Moon className="w-5 h-5" />}
                    </span>
                    <span className="hidden sm:inline">{theme === 'dark' ? 'Light' : 'Dark'}</span>
                </button>
            </div>
        </div>
    )
}
