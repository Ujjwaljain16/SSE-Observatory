import { useEffect, useState } from 'react'
import type { Profile, Theme } from '../types'
import { Plus, X } from 'lucide-react'

interface ProfileTabsProps {
    profiles: Profile[]
    activeProfileTab: string | null
    theme: Theme
    onLoadProfile: (profile: Profile) => void
    onDeleteProfile: (name: string) => void
    onSetActiveTab: (name: string) => void
    onDisconnect: () => void
    connected: boolean
}

const CONFIRM_MS = 4000

export const ProfileTabs = ({
    profiles,
    activeProfileTab,
    theme,
    onLoadProfile,
    onDeleteProfile,
    onSetActiveTab,
    onDisconnect,
    connected
}: ProfileTabsProps) => {
    // Deleting needs a second click on the same profile within a few seconds.
    const [confirming, setConfirming] = useState<string | null>(null)
    useEffect(() => {
        if (!confirming) return
        const timer = setTimeout(() => setConfirming(null), CONFIRM_MS)
        return () => clearTimeout(timer)
    }, [confirming])

    if (profiles.length === 0) return null

    const dark = theme === 'dark'

    const handleProfileClick = (profile: Profile) => {
        onLoadProfile(profile)
        if (connected) onDisconnect()
    }

    const handleDelete = (name: string) => {
        if (confirming === name) {
            setConfirming(null)
            onDeleteProfile(name)
        } else {
            setConfirming(name)
        }
    }

    return (
        <div className="mb-6 animate-slide-up">
            <div role="tablist" aria-label="Saved connection profiles" className={`flex gap-2 flex-wrap border-b pb-4 ${dark ? 'border-slate-700' : 'border-slate-200'}`}>
                {profiles.map(profile => {
                    const active = activeProfileTab === profile.name
                    const asking = confirming === profile.name
                    return (
                        <div
                            key={profile.name}
                            className={`rounded-t-lg font-medium transition-all flex items-center ${active
                                ? dark
                                    ? 'bg-slate-700 text-white border-b-2 border-sky-500'
                                    : 'bg-white text-slate-900 border-b-2 border-sky-600 shadow-md'
                                : dark
                                    ? 'bg-slate-800 text-slate-400 hover:text-white hover:bg-slate-700'
                                    : 'bg-slate-200 text-slate-700 hover:bg-slate-300'
                                }`}
                        >
                            <button
                                role="tab"
                                aria-selected={active}
                                onClick={() => handleProfileClick(profile)}
                                className="pl-4 pr-2 py-2 rounded-tl-lg"
                            >
                                {profile.name}
                            </button>
                            <button
                                onClick={() => handleDelete(profile.name)}
                                onBlur={() => setConfirming((c) => (c === profile.name ? null : c))}
                                aria-label={asking ? `Confirm deleting profile ${profile.name}` : `Delete profile ${profile.name}`}
                                title={asking ? 'Click again to delete' : 'Delete profile'}
                                className={`mr-2 rounded-full transition-colors flex items-center gap-1 text-xs ${asking
                                    ? 'px-2 py-0.5 bg-red-600 text-white'
                                    : `p-0.5 ${dark ? 'hover:bg-red-500/20 hover:text-red-400' : 'hover:bg-red-100 hover:text-red-600'}`
                                    }`}
                            >
                                {asking ? 'Delete?' : <X className="w-3 h-3" aria-hidden="true" />}
                            </button>
                        </div>
                    )
                })}
                <button
                    role="tab"
                    aria-selected={activeProfileTab === 'new'}
                    onClick={() => onSetActiveTab('new')}
                    className={`px-4 py-2 rounded-t-lg font-medium transition-all flex items-center gap-1.5 ${activeProfileTab === 'new'
                        ? dark
                            ? 'bg-slate-700 text-white border-b-2 border-green-500'
                            : 'bg-white text-slate-900 border-b-2 border-green-600 shadow-md'
                        : dark
                            ? 'bg-slate-800 text-slate-400 hover:text-white hover:bg-slate-700'
                            : 'bg-slate-200 text-slate-700 hover:bg-slate-300'
                        }`}
                >
                    <Plus className="w-3 h-3" aria-hidden="true" /> New
                </button>
            </div>
        </div>
    )
}
