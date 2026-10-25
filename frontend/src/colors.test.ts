// Pins the "Dusk 5°" design tokens (#213): the values, WCAG contrast of every text and control
// pair (text 4.5:1, control borders 3:1), and that no colour literal lives outside `:root`.
import { describe, expect, it } from 'vitest'
import { readdirSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

// Vitest runs from frontend/ (the npm script's cwd).
const root = process.cwd()
const css = readFileSync(resolve(root, 'src/index.css'), 'utf8')

function luminance(hex: string): number {
  const [r, g, b] = [1, 3, 5].map((i) => {
    const c = parseInt(hex.slice(i, i + 2), 16) / 255
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4
  }) as [number, number, number]
  return 0.2126 * r + 0.7152 * g + 0.0722 * b
}

function contrast(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [number, number]
  return (hi + 0.05) / (lo + 0.05)
}

/** The `:root { ... }` block, where the tokens (the only colour literals) are defined. */
const rootBlock = css.match(/:root\s*\{([^}]*)\}/)?.[1] ?? ''

function tokens(): Record<string, string> {
  const found: Record<string, string> = {}
  for (const m of rootBlock.matchAll(/--([a-z-]+):\s*(#[0-9a-f]{6})\b/gi)) {
    found[m[1] as string] = (m[2] as string).toLowerCase()
  }
  return found
}

const t = tokens()
function tok(name: string): string {
  const value = t[name]
  if (!value) throw new Error(`token --${name} not found in :root`)
  return value
}

describe('design tokens (#213)', () => {
  it('defines exactly the Dusk 5° palette once, in :root', () => {
    expect(t).toEqual({
      bg: '#11112a',
      surface: '#1b1b3c',
      border: '#33336a',
      'control-border': '#6161b3',
      text: '#edecfb',
      muted: '#ababd3',
      accent: '#949aff',
      'accent-hover': '#b9bdff',
      'on-accent': '#0d0d33',
      error: '#ff8a80',
    })
    expect(css.match(/:root\s*\{/g)).toHaveLength(1)
  })

  it('is a dark colour scheme', () => {
    expect(rootBlock).toMatch(/color-scheme:\s*dark\s*;/)
  })

  it('sets the page chrome to the background token', () => {
    const html = readFileSync(resolve(root, 'index.html'), 'utf8')
    expect(html).toContain(`<meta name="theme-color" content="${tok('bg')}"`)
    const vite = readFileSync(resolve(root, 'vite.config.ts'), 'utf8')
    expect(vite).toContain(`background_color: '${tok('bg')}'`)
    expect(vite).toContain(`theme_color: '${tok('bg')}'`)
  })
})

describe('text contrast is at least 4.5:1 (WCAG AA)', () => {
  const pairs: [string, string, string][] = [
    ['text', 'bg', 'body text on the page'],
    ['text', 'surface', 'body text on cards'],
    ['muted', 'bg', 'secondary text on the page'],
    ['muted', 'surface', 'secondary text on cards'],
    ['accent', 'bg', 'links, selected nav and chart on the page'],
    ['accent', 'surface', 'active nav pill'],
    ['accent-hover', 'bg', 'link hover'],
    ['accent-hover', 'surface', 'hover text on cards'],
    ['on-accent', 'accent', 'text on accent fills'],
    ['on-accent', 'accent-hover', 'text on hovered accent fills'],
    ['error', 'bg', 'error text on the page'],
    ['error', 'surface', 'error text on cards'],
  ]
  it.each(pairs)('%s on %s (%s)', (fg, bg) => {
    expect(contrast(tok(fg), tok(bg))).toBeGreaterThanOrEqual(4.5)
  })

  it('matches the ratios in the design table', () => {
    expect(contrast(tok('text'), tok('bg'))).toBeCloseTo(15.8, 0)
    expect(contrast(tok('muted'), tok('bg'))).toBeCloseTo(8.3, 0)
    expect(contrast(tok('accent'), tok('bg'))).toBeCloseTo(7.3, 0)
    expect(contrast(tok('on-accent'), tok('accent'))).toBeCloseTo(7.4, 0)
    expect(contrast(tok('error'), tok('bg'))).toBeCloseTo(8.1, 0)
  })
})

describe('control borders and focus are at least 3:1 (WCAG 1.4.11)', () => {
  it.each(['bg', 'surface'])('control border on %s', (bg) => {
    expect(contrast(tok('control-border'), tok(bg))).toBeGreaterThanOrEqual(3)
  })
  it.each(['bg', 'surface'])('the focus ring (accent) on %s', (bg) => {
    expect(contrast(tok('accent'), tok(bg))).toBeGreaterThanOrEqual(3)
    expect(css).toMatch(/:focus-visible\s*\{\s*outline:\s*3px solid var\(--accent\)/)
  })
})

describe('no colour literals outside :root (#213)', () => {
  const namedColours =
    /\b(white|black|red|green|blue|gray|grey|silver|yellow|orange|purple|pink|brown|navy|teal|cyan|magenta|lime|maroon|olive|aqua|fuchsia|gold|indigo|violet|coral|salmon|crimson)\b/i
  const literal = /#[0-9a-f]{3,8}\b|\b(?:rgb|rgba|hsl|hsla|hwb|lab|lch|oklab|oklch|color)\(/i

  it('index.css uses only var(--token) for colours', () => {
    const rest = css.replace(/:root\s*\{[^}]*\}/, '').replace(/\/\*[\s\S]*?\*\//g, '')
    expect(rest.match(literal)).toBeNull()
    for (const m of rest.matchAll(
      /([a-z-]*(?:color|background|border|outline|fill|stroke)[a-z-]*):\s*([^;{}]+);/gi,
    )) {
      expect(`${m[1]}: ${m[2]}`).not.toMatch(namedColours)
    }
  })

  it('no component sets a colour literal', () => {
    const files: string[] = []
    const walk = (dir: string) => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const path = join(dir, entry.name)
        if (entry.isDirectory()) walk(path)
        else if (/\.(ts|tsx)$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name))
          files.push(path)
      }
    }
    walk(resolve(root, 'src'))
    expect(files.length).toBeGreaterThan(20)
    for (const file of files) {
      expect(readFileSync(file, 'utf8').match(literal), file).toBeNull()
    }
  })
})
