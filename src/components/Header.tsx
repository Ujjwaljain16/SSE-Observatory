import type { Theme } from '../types'
import { Activity, Sun, Moon, Github, BookOpen } from 'lucide-react'

interface HeaderProps {
    theme: Theme
    onToggleTheme: () => void
}

export const Header = ({ theme, onToggleTheme }: HeaderProps) => {
    return (
        <div className="flex flex-wrap items-center justify-between gap-4 mb-10 animate-fade-in">
            <div className="relative">
                {/* Decorative glow */}
                <div className="absolute -inset-4 bg-gradient-to-r from-slate-600/10 via-slate-500/10 to-slate-400/10 blur-3xl opacity-40 -z-10" />

                <div className="flex items-center gap-3 sm:gap-4">
                    {/* Animated Logo */}
                    <div className={`
                        w-12 h-12 sm:w-16 sm:h-16 shrink-0 rounded-2xl flex items-center justify-center
                        bg-gradient-to-br from-sky-500 via-blue-500 to-cyan-500
                        shadow-lg shadow-blue-500/30 hover:shadow-blue-500/50
                        transition-all duration-300 hover:scale-105 hover:rotate-3
                    `}>
                        <Activity className="w-8 h-8 text-white" />
                    </div>

                    <div>
                        <h1 className={`
                            text-3xl sm:text-4xl md:text-5xl font-extrabold tracking-tight
                            bg-gradient-to-r from-sky-400 via-blue-400 to-cyan-400
                            bg-clip-text text-transparent
                            drop-shadow-sm
                        `}>
                            SSE Observatory
                        </h1>
                        <p className={`text-sm sm:text-base mt-1 flex items-center gap-2 ${theme === 'dark' ? 'text-slate-400' : 'text-slate-600'
                            }`}>
                            <span className="live-dot" />
                            Real-time event monitoring & debugging
                        </p>
                    </div>
                </div>
            </div>

            <div className="flex items-center gap-3">
                {/* Docs Link */}
                <a
                    href="/docs/"
                    target="_blank"
                    rel="noopener noreferrer"
                    className={`
                        p-2.5 rounded-xl transition-all duration-300 hover:scale-105
                        ${theme === 'dark'
                            ? 'bg-slate-800/50 hover:bg-slate-700/70 text-slate-400 hover:text-white border border-slate-700/50'
                            : 'bg-slate-100 hover:bg-slate-200 text-slate-600 hover:text-slate-900 border border-slate-200'
                        }
                    `}
                    aria-label="Documentation"
                    title="Documentation"
                >
                    <BookOpen className="w-5 h-5" />
                </a>

                {/* GitHub Link */}
                <a
                    href="https://github.com/Ujjwaljain16/SSE-Observatory"
                    target="_blank"
                    rel="noopener noreferrer"
                    className={`
                        p-2.5 rounded-xl transition-all duration-300 hover:scale-105
                        ${theme === 'dark'
                            ? 'bg-slate-800/50 hover:bg-slate-700/70 text-slate-400 hover:text-white border border-slate-700/50'
                            : 'bg-slate-100 hover:bg-slate-200 text-slate-600 hover:text-slate-900 border border-slate-200'
                        }
                    `}
                    aria-label="View source on GitHub"
                    title="View Source"
                >
                    <Github className="w-5 h-5" />
                </a>

                {/* Theme Toggle */}
                <button
                    onClick={onToggleTheme}
                    className={`
                        p-2.5 rounded-xl transition-all duration-300 hover:scale-105
                        ${theme === 'dark'
                            ? 'bg-slate-800/50 hover:bg-slate-700/70 text-sky-400 hover:text-sky-300 border border-slate-700/50'
                            : 'bg-slate-100 hover:bg-slate-200 text-orange-500 hover:text-orange-600 border border-slate-200'
                        }
                    `}
                    aria-label={`Switch to ${theme === 'dark' ? 'light' : 'dark'} mode`}
                    title={`Switch to ${theme === 'dark' ? 'Light' : 'Dark'} Mode`}
                >
                    {theme === 'dark' ? <Sun className="w-5 h-5" /> : <Moon className="w-5 h-5" />}
                </button>
            </div>
        </div>
    )
}
