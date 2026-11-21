import type { Theme } from '../types'
import { toolVersion } from '../core/version'

interface FooterProps {
    theme: Theme
}

export const Footer = ({ theme }: FooterProps) => {
    return (
        <div className={`mt-8 text-center text-sm ${
            theme === 'dark'
                ? 'text-slate-300'
                : 'text-slate-600'
        }`}>
            <p>SSE Observatory v{toolVersion()} | Built with React + Tailwind CSS</p>
        </div>
    )
}
