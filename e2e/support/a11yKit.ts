import fs from 'node:fs'
import path from 'node:path'
import AxeBuilder from '@axe-core/playwright'
import { expect, type Locator, type Page, type TestInfo } from '@playwright/test'

// Checks for the accessibility audit (e2e/a11y.audit.spec.ts). What they find is what a program can find: rules (axe), the browser's own
// accessibility tree (names), the order and look of keyboard focus, motion that should stop, text that is clipped at 200%. None of it is
// a screen reader: it says nothing about what is announced, in what order, or whether that makes sense to the person listening.

export const TAGS = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa']

export interface Combo { theme: 'light' | 'dark'; width: number; height: number }
export const COMBOS: Combo[] = [
    { theme: 'light', width: 1360, height: 900 },
    { theme: 'dark', width: 1360, height: 900 },
    { theme: 'light', width: 360, height: 740 },
    { theme: 'dark', width: 360, height: 740 },
]
export const comboName = (c: Combo): string => `${c.theme} ${c.width}px`

/** Settings every audited page starts with: the theme, and the reduced-motion preference (the app is meant to honour it; it is checked on its own below). */
export async function prepare(page: Page, combo: Combo): Promise<void> {
    await page.emulateMedia({ reducedMotion: 'reduce', colorScheme: combo.theme })
    await page.addInitScript((theme) => { try { localStorage.setItem('sse-theme', theme) } catch { /* storage unavailable */ } }, combo.theme)
    await page.setViewportSize({ width: combo.width, height: combo.height })
}

/** Waits until every animation that will end has ended, so a colour or position is measured where it stays. */
export async function settle(page: Page): Promise<void> {
    await page.evaluate(async () => {
        const finite = () => document.getAnimations().filter((a) => a.effect?.getComputedTiming().iterations !== Infinity)
        await Promise.all(finite().map((a) => a.finished.catch(() => undefined)))
        await new Promise<void>((r) => requestAnimationFrame(() => requestAnimationFrame(() => r())))
    })
}

// ---------------------------------------------------------------------------------------------------------------- accessible names

const NAMED_ROLES = new Set(['button', 'link', 'textbox', 'searchbox', 'checkbox', 'radio', 'switch', 'tab', 'combobox', 'spinbutton', 'slider', 'menuitem', 'menuitemcheckbox', 'menuitemradio', 'PopUpButton', 'DisclosureTriangle', 'ComboBoxSelect', 'dialog', 'alertdialog', 'tablist', 'listbox'])
const FIELD_ROLES = new Set(['textbox', 'searchbox', 'combobox', 'spinbutton', 'ComboBoxSelect'])

interface AxNode {
    ignored?: boolean
    role?: { value: string }
    name?: { value?: string; sources?: Array<{ type: string; attribute?: string; superseded?: boolean; value?: { value?: unknown } }> }
    backendDOMNodeId?: number
    properties?: Array<{ name: string; value: { value: unknown } }>
}

/**
 * The browser's own accessibility tree (Chrome DevTools Protocol): every interactive element, dialog and tab list that is exposed must have a
 * name, and a form field must not take its only name from its placeholder (it is not a label: it is gone as soon as something is typed).
 */
export async function nameProblems(page: Page): Promise<string[]> {
    const cdp = await page.context().newCDPSession(page)
    try {
        await cdp.send('DOM.enable')
        await cdp.send('Accessibility.enable')
        const { nodes } = (await cdp.send('Accessibility.getFullAXTree')) as unknown as { nodes: AxNode[] }
        const out: string[] = []
        const describe = async (n: AxNode): Promise<string> => {
            if (n.backendDOMNodeId === undefined) return '?'
            try {
                const { node } = (await cdp.send('DOM.describeNode', { backendNodeId: n.backendDOMNodeId })) as unknown as { node: { nodeName: string; attributes?: string[] } }
                const attrs = node.attributes ?? []
                const get = (k: string) => { const i = attrs.indexOf(k); return i >= 0 ? attrs[i + 1] : undefined }
                const id = get('data-testid')
                const cls = (get('class') ?? '').split(/\s+/).slice(0, 3).join('.')
                return `${node.nodeName.toLowerCase()}${id ? `[data-testid=${id}]` : ''}${get('type') ? `[type=${get('type')}]` : ''}${get('placeholder') ? ` placeholder="${get('placeholder')}"` : ''}${!id && cls ? `.${cls}` : ''}`
            } catch { return '?' }
        }
        for (const n of nodes) {
            if (n.ignored) continue
            const role = n.role?.value ?? ''
            if (!NAMED_ROLES.has(role)) continue
            if (n.properties?.some((p) => p.name === 'hidden' && p.value.value === true)) continue
            const name = (n.name?.value ?? '').trim()
            if (name === '') { out.push(`${role} has no accessible name: ${await describe(n)}`); continue }
            if (FIELD_ROLES.has(role)) {
                const used = (n.name?.sources ?? []).filter((s) => !s.superseded && typeof s.value?.value === 'string' && (s.value.value as string).trim() !== '')
                if (used.length > 0 && used.every((s) => s.type === 'placeholder' || s.attribute === 'placeholder')) out.push(`${role} is named only by its placeholder ("${name}"): ${await describe(n)}`)
            }
        }
        return out
    } finally { await cdp.detach().catch(() => undefined) }
}

// ---------------------------------------------------------------------------------------------------------------- keyboard focus

export interface WalkResult { stops: number; problems: string[] }

/**
 * Presses Tab from the top of the page (or from `from`) and, at every stop, checks that focus can be seen (an outline that is not
 * transparent, or a box-shadow, border or background that changes when the element loses focus) and that the order follows the page: within
 * one region the next stop is not above or left of the previous one. Stops when focus comes round to a stop it has already made, or at `max`.
 */
export async function tabWalk(page: Page, options: { max?: number; from?: Locator } = {}): Promise<WalkResult> {
    const max = options.max ?? 70
    await page.evaluate(() => {
        const style = document.createElement('style')
        style.id = '__a11y-notransition'
        style.textContent = '*,*::before,*::after{transition:none !important;animation:none !important}'
        document.head.append(style)
        ;(window as unknown as { __seen: WeakSet<Element> }).__seen = new WeakSet()
    })
    if (options.from) await options.from.focus()
    else {
        await page.evaluate(() => {
            const anchor = document.createElement('span')
            anchor.id = '__a11y-anchor'
            anchor.tabIndex = -1
            document.body.prepend(anchor)
            window.scrollTo(0, 0)
            anchor.focus()
        })
    }
    const problems: string[] = []
    let previous: { region: string; top: number; left: number; bottom: number; right: number; desc: string } | null = null
    let stops = 0
    for (; stops < max; stops++) {
        await page.keyboard.press('Tab')
        const stop = await page.evaluate(() => {
            const el = document.activeElement as HTMLElement | null
            if (!el || el === document.body || el.id === '__a11y-anchor') return { end: true as const }
            const w = window as unknown as { __seen: WeakSet<Element>; __regions?: WeakMap<Element, number>; __nextRegion?: number }
            if (w.__seen.has(el)) return { end: true as const }
            w.__seen.add(el)
            const idOf = (r: Element): number => {
                w.__regions ??= new WeakMap()
                w.__nextRegion ??= 1
                if (!w.__regions.has(r)) w.__regions.set(r, w.__nextRegion++)
                return w.__regions.get(r)!
            }
            // A box that scrolls on its own (a dialog's body, a table that scrolls sideways) has coordinates of its own: it is a region compared only with itself.
            const scrollerOf = (e: Element): Element | null => {
                for (let p = e.parentElement; p && p !== document.body && p !== document.documentElement; p = p.parentElement) {
                    const cs = getComputedStyle(p)
                    const scrolls = (/(auto|scroll)/.test(cs.overflowY) && p.scrollHeight > p.clientHeight + 1) || (/(auto|scroll)/.test(cs.overflowX) && p.scrollWidth > p.clientWidth + 1)
                    if (scrolls) return p
                }
                return null
            }
            const fixedOf = (e: Element): Element | null => {
                for (let p: Element | null = e; p; p = p.parentElement) { const pos = getComputedStyle(p).position; if (pos === 'fixed' || pos === 'sticky') return p }
                return null
            }
            const regionOf = (e: Element): string => {
                const scroller = scrollerOf(e)
                if (scroller) return `scroll${idOf(scroller)}`
                const fixed = fixedOf(e)
                if (fixed) return `fixed${idOf(fixed)}`
                const r = e.parentElement?.closest('[role=dialog],[role=alertdialog],[role=tabpanel],[role=tablist],form,fieldset,details,section,nav,aside,header,footer,main,ul,ol,table')
                return r ? String(idOf(r)) : 'page'
            }
            // Where the element is in its region, whatever has scrolled: the box's own scroll is added back. Inside something fixed (a dialog) the window's scroll does not count.
            const docOffset = (e: Element): { top: number; left: number } => {
                const r = e.getBoundingClientRect()
                let top = r.top, left = r.left
                const fixed = fixedOf(e)
                for (let p = e.parentElement; p; p = p.parentElement) {
                    if (fixed && !fixed.contains(p) && p !== fixed) break
                    top += p.scrollTop; left += p.scrollLeft
                    if (p === fixed) break
                }
                return { top, left }
            }
            const describe = (e: Element): string => {
                const id = e.getAttribute('data-testid')
                const label = e.getAttribute('aria-label') ?? e.getAttribute('placeholder') ?? (e.textContent ?? '').trim().replace(/\s+/g, ' ').slice(0, 30)
                return `${e.tagName.toLowerCase()}${id ? `[${id}]` : ''}${label ? ` "${label}"` : ''}`
            }
            const snap = (e: Element) => { const cs = getComputedStyle(e); return [cs.outlineStyle, cs.outlineWidth, cs.outlineColor, cs.boxShadow, cs.borderTopColor, cs.borderBottomColor, cs.backgroundColor, cs.color, cs.textDecorationLine].join('|') }
            const focused = getComputedStyle(el)
            const alpha = (c: string): number => { const m = /rgba?\(([^)]+)\)/.exec(c); if (!m) return 1; const p = m[1]!.split(/[ ,/]+/).filter(Boolean); return p.length >= 4 ? Number(p[3]) : 1 }
            const outline = focused.outlineStyle !== 'none' && parseFloat(focused.outlineWidth) > 0 && alpha(focused.outlineColor) > 0
            const withFocus = snap(el)
            el.blur()
            const without = snap(el)
            el.focus({ preventScroll: true })
            const rect = el.getBoundingClientRect()
            const off = docOffset(el)
            return {
                end: false as const,
                desc: describe(el),
                region: regionOf(el),
                visible: outline || withFocus !== without,
                tabindex: el.getAttribute('tabindex'),
                top: off.top, left: off.left, bottom: off.top + rect.height, right: off.left + rect.width,
                // WCAG 2.2 focus not obscured: where the element is on screen, what is at its centre is the element (or part of it), not a bar or a banner on top of it.
                // An element that is not on screen is not judged: on a live list the rows move under the focus between the key press and the measurement.
                coveredBy: (() => {
                    // "entirely hidden" is the failure: five points of the element (the centre and the four corners, a little in) are all under something else
                    const points = [[0.5, 0.5], [0.1, 0.1], [0.9, 0.1], [0.1, 0.9], [0.9, 0.9]].map(([x, y]) => [rect.left + rect.width * x!, rect.top + rect.height * y!] as const)
                    const visible = points.filter(([x, y]) => x >= 0 && y >= 0 && x < innerWidth && y < innerHeight)
                    if (visible.length === 0) return ''
                    const covers = visible.map(([x, y]) => document.elementFromPoint(x, y)).map((top) => (top && !el.contains(top) && !top.contains(el) ? top : null))
                    return covers.every((c) => c !== null) ? describe(covers[0]!) : ''
                })(),
            }
        })
        if (stop.end) break
        if (!stop.visible) problems.push(`no visible focus indicator on ${stop.desc}`)
        if (stop.tabindex !== null && Number(stop.tabindex) > 0) problems.push(`positive tabindex (${stop.tabindex}) on ${stop.desc}`)
        if (stop.coveredBy) problems.push(`focus is on ${stop.desc} and ${stop.coveredBy} is on top of it`)
        if (previous && previous.region === stop.region) {
            // the next stop is below the last one; or on the same row and to its right; or in the next column (above, but wholly to the right)
            const below = stop.top >= previous.bottom - 4
            const sameRow = stop.top >= previous.top - 8 && stop.top < previous.bottom
            const nextColumn = stop.left >= previous.right - 4
            if (!(below || (sameRow && stop.left >= previous.left - 4) || nextColumn)) problems.push(`focus order differs from the visual order: ${previous.desc} is followed by ${stop.desc}, which is above or to the left of it`)
        }
        previous = { region: stop.region, top: stop.top, left: stop.left, bottom: stop.bottom, right: stop.right, desc: stop.desc }
    }
    await page.evaluate(() => { document.getElementById('__a11y-notransition')?.remove(); document.getElementById('__a11y-anchor')?.remove() })
    return { stops, problems }
}

// ---------------------------------------------------------------------------------------------------------------- motion

/** With the reduced-motion preference on, nothing may be left with an animation, and no transition may take longer than a blink. */
export async function motionProblems(page: Page): Promise<string[]> {
    return page.evaluate(() => {
        const out = new Map<string, number>()
        const seconds = (s: string): number => Math.max(0, ...s.split(',').map((x) => (x.trim().endsWith('ms') ? parseFloat(x) / 1000 : parseFloat(x) || 0)))
        for (const el of Array.from(document.querySelectorAll('*'))) {
            const cs = getComputedStyle(el)
            const key = `${el.tagName.toLowerCase()}.${(el.getAttribute('class') ?? '').split(/\s+/).filter((c) => /animate|transition|duration/.test(c)).join('.')}`
            if (cs.animationName !== 'none' && seconds(cs.animationDuration) > 0.05) out.set(`animation "${cs.animationName}" (${cs.animationDuration}) on ${key}`, (out.get(key) ?? 0) + 1)
            if (cs.transitionProperty !== 'none' && seconds(cs.transitionDuration) > 0.05) out.set(`transition ${cs.transitionDuration} on ${key}`, 1)
        }
        return [...out.keys()]
    })
}

// ---------------------------------------------------------------------------------------------------------------- text at 200%

/**
 * At 200% text size (a 680 px viewport, half of 1360) nothing in `scope` is cut off, overlaps another piece of text, or makes the page scroll
 * sideways. Text that is truncated with an ellipsis, or whose box clips its content, is reported unless the element can be scrolled.
 */
export async function resizeProblems(page: Page, scope: string): Promise<string[]> {
    return page.evaluate((sel) => {
        const out: string[] = []
        const root = document.querySelector(sel)
        if (!root) return [`${sel} is not on the page`]
        if (document.documentElement.scrollWidth > document.documentElement.clientWidth + 1) out.push(`the page scrolls sideways (${document.documentElement.scrollWidth} px in ${document.documentElement.clientWidth} px)`)
        const describe = (e: Element): string => `${e.tagName.toLowerCase()}${e.getAttribute('data-testid') ? `[${e.getAttribute('data-testid')}]` : ''} "${(e.textContent ?? '').trim().replace(/\s+/g, ' ').slice(0, 40)}"`
        // checkVisibility() also sees content-visibility: Chromium hides a closed <details>' content that way, and that content keeps a box on top of what follows.
        const visible = (e: Element): boolean => { const r = e.getBoundingClientRect(); const cs = getComputedStyle(e); return r.width > 0 && r.height > 0 && cs.visibility !== 'hidden' && cs.display !== 'none' && e.checkVisibility({ contentVisibilityAuto: true }) }
        const texty: Element[] = []
        for (const e of Array.from(root.querySelectorAll('*'))) {
            if (!visible(e)) continue
            const cs = getComputedStyle(e)
            if (e.closest('.sr-only') || e.closest('[aria-hidden=true]')) continue
            const hasOwnText = Array.from(e.childNodes).some((n) => n.nodeType === Node.TEXT_NODE && (n.textContent ?? '').trim() !== '')
            if (hasOwnText) texty.push(e)
            const clipsX = ['hidden', 'clip'].includes(cs.overflowX) && e.scrollWidth > e.clientWidth + 1
            const clipsY = ['hidden', 'clip'].includes(cs.overflowY) && e.scrollHeight > e.clientHeight + 1
            if ((clipsX || clipsY) && (e.textContent ?? '').trim() !== '' && !e.matches('pre, code')) out.push(`clipped: ${describe(e)} (${cs.textOverflow === 'ellipsis' ? 'truncated with an ellipsis' : 'overflow hidden'}, content ${e.scrollWidth}x${e.scrollHeight} in ${e.clientWidth}x${e.clientHeight})`)
        }
        // what can be seen of an element: its box cut by every ancestor that clips or scrolls (the part of a dialog's body that has scrolled out of sight is not on top of anything)
        const shown = (e: Element): DOMRect | null => {
            let { left, top, right, bottom } = e.getBoundingClientRect()
            for (let p = e.parentElement; p; p = p.parentElement) {
                const cs = getComputedStyle(p)
                if (cs.overflowX === 'visible' && cs.overflowY === 'visible') continue
                const r = p.getBoundingClientRect()
                left = Math.max(left, r.left); top = Math.max(top, r.top); right = Math.min(right, r.right); bottom = Math.min(bottom, r.bottom)
            }
            return right > left && bottom > top ? new DOMRect(left, top, right - left, bottom - top) : null
        }
        for (let i = 0; i < texty.length; i++) {
            const a = texty[i]!
            const ra = shown(a)
            if (!ra) continue
            for (let j = i + 1; j < texty.length; j++) {
                const b = texty[j]!
                if (a.contains(b) || b.contains(a)) continue
                const rb = shown(b)
                if (!rb) continue
                const w = Math.min(ra.right, rb.right) - Math.max(ra.left, rb.left)
                const h = Math.min(ra.bottom, rb.bottom) - Math.max(ra.top, rb.top)
                if (w > 3 && h > 3) out.push(`overlap: ${describe(a)} and ${describe(b)}`)
            }
        }
        return out.slice(0, 40)
    }, scope)
}

// ---------------------------------------------------------------------------------------------------------------- contrast

export interface Contrast { ratio: number; required: number; backdrop: 'solid' | 'gradient (worst colour of its stops)' }

/**
 * WCAG contrast of an element's text against what is behind it, the layers composited. Where a gradient is behind the text, which axe
 * reports as "could not be determined", the worst case is taken: the contrast against each colour stop of the gradient, the lowest of them.
 * Null when something it cannot know sits behind the text (a picture). `required` is 3 for large text (24 px, or 18.66 px bold) and 4.5 otherwise.
 */
export const contrastFn = (el: Element): { ratio: number; required: number; backdrop: string } | null => {
    type Rgba = [number, number, number, number]
    const parse = (c: string): Rgba | null => {
        const m = /rgba?\(([^)]+)\)/.exec(c)
        if (!m) return null
        const p = m[1]!.split(/[ ,/]+/).filter(Boolean).map(Number)
        return [p[0]!, p[1]!, p[2]!, p.length >= 4 ? p[3]! : 1]
    }
    const over = (top: Rgba, bottom: Rgba): Rgba => {
        const a = top[3] + bottom[3] * (1 - top[3])
        if (a === 0) return [0, 0, 0, 0]
        return [0, 1, 2].map((i) => (top[i]! * top[3] + bottom[i]! * bottom[3] * (1 - top[3])) / a).concat(a) as Rgba
    }
    const lum = (c: number[]): number => { const f = (v: number) => { const s = v / 255; return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4 }; return 0.2126 * f(c[0]!) + 0.7152 * f(c[1]!) + 0.0722 * f(c[2]!) }
    let candidates: Rgba[] = [[0, 0, 0, 0]]
    let gradient = false
    // text painted by its own gradient (background-clip: text with a transparent fill): the colours of that gradient are the text colour
    const own0 = getComputedStyle(el)
    const clip = (own0.backgroundClip || (own0 as unknown as Record<string, string>)['webkitBackgroundClip']) === 'text'
    const textStops = clip && /gradient/.test(own0.backgroundImage) ? Array.from(own0.backgroundImage.matchAll(/rgba?([^)]+)/g)).map((m) => parse(m[0])) : null
    if (textStops && textStops.some((x) => x === null)) return null
    for (let e: Element | null = textStops ? el.parentElement : el; e; e = e.parentElement) {
        const cs = getComputedStyle(e)
        let layers: Rgba[]
        const own = parse(cs.backgroundColor)
        if (!own) return null
        if (cs.backgroundImage !== 'none') {
            if (!/^(repeating-)?(linear|radial)-gradient/.test(cs.backgroundImage)) return null
            const stops = Array.from(cs.backgroundImage.matchAll(/rgba?\([^)]+\)/g)).map((m) => parse(m[0]))
            if (stops.length === 0 || stops.some((s) => s === null)) return null
            gradient = true
            layers = (stops as Rgba[]).map((s) => over(s, own))
        } else layers = [own]
        candidates = candidates.flatMap((x) => (x[3] >= 0.999 ? [x] : layers.map((l) => over(x, l))))
        if (candidates.every((x) => x[3] >= 0.999)) break
    }
    candidates = candidates.map((x) => (x[3] < 0.999 ? over(x, [255, 255, 255, 1]) : x))
    const cs = getComputedStyle(el)
    const svg = el instanceof SVGElement
    const fgRaw = parse(svg ? cs.fill : cs.color)
    if (!fgRaw) return null
    const size = parseFloat(cs.fontSize)
    const bold = Number(cs.fontWeight) >= 700
    const required = size >= 24 || (bold && size >= 18.66) ? 3 : 4.5
    let worst = Infinity
    const foregrounds: Rgba[] = textStops ? (textStops as Rgba[]) : [fgRaw]
    if ((el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) && el.value === '' && el.placeholder) {
        const placeholder = parse(getComputedStyle(el, '::placeholder').color)
        if (placeholder) foregrounds.push(placeholder)
    }
    for (const bg of candidates) for (const fgColour of foregrounds) {
        const fg = over(fgColour, bg)
        const l1 = lum(fg), l2 = lum(bg)
        worst = Math.min(worst, (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05))
    }
    return { ratio: worst, required, backdrop: gradient ? 'gradient (worst colour of its stops)' : 'solid' }
}

export async function contrastOf(locator: Locator): Promise<Contrast | null> {
    return (await locator.evaluate(contrastFn)) as Contrast | null
}

// ---------------------------------------------------------------------------------------------------------------- the audit itself

export interface Incomplete { rule: string; help: string; state: string; target: string; why: string }

const RESULT_DIR = path.join('test-results', 'a11y-audit')

/** Runs every check on a state of the page and keeps what it finds, so a test can walk many states and fail once with all of them. */
export class Audit {
    readonly problems: string[] = []
    readonly states: string[] = []
    readonly incomplete: Incomplete[] = []
    readonly informational: string[] = []
    gradientChecked = 0
    constructor(readonly page: Page, readonly combo: Combo) {}

    /** @param options.walk press Tab through the page (or a dialog) and check focus; @param options.motion check that animations are off under reduced motion */
    async state(label: string, options: { walk?: boolean; motion?: boolean; bestPractice?: boolean } = {}): Promise<void> {
        const { page } = this
        const began = Date.now()
        const here = `${label} [${comboName(this.combo)}]`
        this.states.push(label)
        await settle(page)
        const builder = new AxeBuilder({ page }).withTags(TAGS)
        const results = await builder.analyze()
        for (const v of results.violations) {
            const nodes = v.nodes.slice(0, 6).map((n) => `      ${n.target.join(' ')} -- ${(n.failureSummary ?? '').replace(/\s+/g, ' ').replace(/Fix (any|all) of the following: /, '').slice(0, 230)}`)
            this.problems.push(`${here}: axe ${v.id} (${v.impact}) ${v.help} [${v.nodes.length}]:\n${nodes.join('\n')}`)
        }
        const gradientTargets = new Map<string, string>()
        for (const v of results.incomplete) {
            for (const n of v.nodes) {
                const why = (n.any[0]?.message ?? n.all[0]?.message ?? n.none[0]?.message ?? '').slice(0, 200)
                // axe cannot decide the contrast of text on a gradient, partly under another element, of one character, of a field with nothing typed, or of SVG text:
                // it is worked out here from the computed colours (against every colour of a gradient, the worst), and only what cannot be worked out is left for a person
                if (v.id === 'color-contrast' && n.target.length === 1) gradientTargets.set(n.target[0] as string, n.html.slice(0, 80))
                else this.incomplete.push({ rule: v.id, help: v.help, state: here, target: n.target.join(' '), why })
            }
        }
        if (gradientTargets.size > 0) {
            const selectors = [...gradientTargets.keys()]
            const answers = await page.evaluate(([src, sels]) => {
                const fn = new Function(`return (${src})`)() as (el: Element) => { ratio: number; required: number } | null
                return (sels as string[]).map((s) => {
                    try {
                        const all = Array.from(document.querySelectorAll(s)).map((e) => fn(e))
                        let worst: { ratio: number; required: number } | null = null
                        for (const x of all) {
                            if (x === null) return null
                            if (worst === null || x.ratio - x.required < worst.ratio - worst.required) worst = x
                        }
                        return worst
                    } catch { return null }
                })
            }, [contrastFn.toString(), selectors] as const)
            answers.forEach((c, i) => {
                const sel = selectors[i]!
                if (c === null) this.incomplete.push({ rule: 'color-contrast', help: 'Elements must meet minimum color contrast ratio thresholds', state: here, target: sel, why: 'axe could not decide, and the computed colours do not say (a picture, or a colour this check cannot read)' })
                else {
                    this.gradientChecked++
                    if (c.ratio < c.required) this.problems.push(`${here}: contrast ${c.ratio.toFixed(2)}:1 (needs ${c.required}:1) (against the worst colour behind it): ${sel}  ${gradientTargets.get(sel)}`)
                }
            })
        }
        // axe's best-practice rules (landmarks, heading order, ...) are not WCAG failures: kept as information, not failures
        if (this.states.length === 1 || options.bestPractice) {
            const extra = await new AxeBuilder({ page }).withTags(['best-practice']).analyze()
            for (const v of extra.violations) this.informational.push(`${here}: ${v.id} (${v.impact}) ${v.help} [${v.nodes.length}] e.g. ${v.nodes[0]?.target.join(' ')}`)
        }
        for (const p of await nameProblems(page)) this.problems.push(`${here}: ${p}`)
        if (options.motion) for (const p of await motionProblems(page)) this.problems.push(`${here}: reduced motion is on, but ${p}`)
        if (options.walk) {
            const walk = await tabWalk(page)
            if (walk.stops === 0) this.problems.push(`${here}: Tab reached nothing`)
            for (const p of walk.problems) this.problems.push(`${here}: ${p}`)
        }
        if (process.env['A11Y_TIMING']) console.log(`STATE ${Date.now() - began} ms ${here}`)
    }

    /** Writes what was seen to test-results/a11y-audit (for the report) and attaches it to the test. */
    async finish(info: TestInfo): Promise<void> {
        fs.mkdirSync(RESULT_DIR, { recursive: true })
        const body = { test: info.title, combo: comboName(this.combo), problems: this.problems, states: this.states, gradientTextChecked: this.gradientChecked, incomplete: this.incomplete, informational: this.informational }
        fs.writeFileSync(path.join(RESULT_DIR, `${comboName(this.combo)} ${info.title}`.replace(/[^a-z0-9]+/gi, "-").slice(0, 100) + ".json"), JSON.stringify(body, null, 1))
        await info.attach('audit', { body: JSON.stringify(body, null, 1), contentType: 'application/json' })
        expect(this.problems, `${this.problems.length} problem${this.problems.length === 1 ? '' : 's'} in ${this.states.length} states:\n${this.problems.join('\n')}`).toEqual([])
    }
}
