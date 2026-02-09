import type { Theme } from '../types'

interface FooterProps {
    theme: Theme
}

export const Footer = ({ theme }: FooterProps) => {
    return (
        <div className={`mt-8 text-center text-sm ${
            theme === 'dark'
                ? 'text-slate-500'
                : 'text-slate-600'
        }`}>
            <p>SSE Monitor v1.0 | Built with React + Tailwind CSS</p>
        </div>
    )
}
