import { render } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { Footer } from '../Footer'
import pkg from '../../../package.json'

// The version in the footer was a hard-coded string, a second place to bump on every release (and scripts/live-smoke.mjs checks it against
// package.json). It comes from the same single source as the tool version in every capture.
describe('Footer', () => {
    it('shows the version in package.json, whichever it is', () => {
        const { container } = render(<Footer theme="light" />)
        expect(container.textContent).toContain(`SSE Observatory v${pkg.version} |`)
    })
})
