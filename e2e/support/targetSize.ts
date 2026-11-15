import type { Page } from '@playwright/test'

// WCAG 2.2 success criterion 2.5.8 (Target Size, Minimum, level AA): a pointer target is at least 24 by 24 CSS pixels. Measured the way
// the acceptance test measured it: getBoundingClientRect over every button, link, input and tab that is visible, leaving out a link that is
// part of a sentence (the criterion's "inline" exception). Hidden inputs, and anything not rendered (display none, zero size,
// visibility hidden), are not targets.

export interface SmallTarget { name: string; width: number; height: number }

export async function smallTargets(page: Page): Promise<SmallTarget[]> {
    return page.evaluate(() => {
        const out: Array<{ name: string; width: number; height: number }> = []
        const describe = (el: Element): string => {
            const label = el.getAttribute('aria-label') ?? el.getAttribute('title') ?? (el.textContent ?? '').trim().replace(/\s+/g, ' ').slice(0, 30)
            const id = el.getAttribute('data-testid')
            return `${el.tagName.toLowerCase()}${el.getAttribute('type') ? `[${el.getAttribute('type')}]` : ''}${id ? `#${id}` : ''}${label ? ` "${label}"` : ''}`
        }
        // A link that sits in running text is the criterion's "inline" exception.
        const insideSentence = (a: Element): boolean => {
            if (a.tagName !== 'A' || getComputedStyle(a).display !== 'inline') return false
            const parent = a.parentElement
            if (!parent) return false
            // there are words around it: the parent's text is more than its own
            return (parent.textContent ?? '').replace(/\s+/g, ' ').trim().length > (a.textContent ?? '').replace(/\s+/g, ' ').trim().length
        }
        for (const el of Array.from(document.querySelectorAll('button, a, input, [role="tab"]'))) {
            if (el instanceof HTMLInputElement && el.type === 'hidden') continue
            const style = getComputedStyle(el)
            if (style.display === 'none' || style.visibility === 'hidden') continue
            const r = el.getBoundingClientRect()
            if (r.width === 0 || r.height === 0) continue
            if (r.width <= 1 && r.height <= 1) continue // visually hidden (the file input behind a labelled button): the label is the target
            if (insideSentence(el)) continue
            if (r.width < 24 || r.height < 24) out.push({ name: describe(el), width: Math.round(r.width * 10) / 10, height: Math.round(r.height * 10) / 10 })
        }
        return out
    })
}

export const describeTargets = (targets: SmallTarget[]): string =>
    targets.map((t) => `${t.name} ${t.width}x${t.height}`).join('\n')
