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
  // Every CSS named colour plus the system colours; `transparent`, `currentColor` and `inherit` are fine.
  const NAMED = (
    'aliceblue antiquewhite aqua aquamarine azure beige bisque black blanchedalmond blue blueviolet brown burlywood cadetblue chartreuse chocolate coral cornflowerblue cornsilk crimson cyan darkblue darkcyan darkgoldenrod darkgray darkgreen darkgrey darkkhaki darkmagenta darkolivegreen darkorange darkorchid darkred darksalmon darkseagreen darkslateblue darkslategray darkslategrey darkturquoise darkviolet deeppink deepskyblue dimgray dimgrey dodgerblue firebrick floralwhite forestgreen fuchsia gainsboro ghostwhite gold goldenrod gray green greenyellow grey honeydew hotpink indianred indigo ivory khaki lavender lavenderblush lawngreen lemonchiffon lightblue lightcoral lightcyan lightgoldenrodyellow lightgray lightgreen lightgrey lightpink lightsalmon lightseagreen lightskyblue lightslategray lightslategrey lightsteelblue lightyellow lime limegreen linen magenta maroon mediumaquamarine mediumblue mediumorchid mediumpurple mediumseagreen mediumslateblue mediumspringgreen mediumturquoise mediumvioletred midnightblue mintcream mistyrose moccasin navajowhite navy oldlace olive olivedrab orange orangered orchid palegoldenrod palegreen paleturquoise palevioletred papayawhip peachpuff peru pink plum powderblue purple rebeccapurple red rosybrown royalblue saddlebrown salmon sandybrown seagreen seashell sienna silver skyblue slateblue slategray slategrey snow springgreen steelblue tan teal thistle tomato turquoise violet wheat white whitesmoke yellow yellowgreen ' +
    'accentcolor accentcolortext activetext buttonborder buttonface buttontext canvas canvastext field fieldtext graytext highlight highlighttext linktext mark marktext selecteditem selecteditemtext visitedtext activeborder activecaption appworkspace background captiontext inactiveborder inactivecaption inactivecaptiontext infobackground infotext menu menutext scrollbar threeddarkshadow threedface threedhighlight threedlightshadow threedshadow window windowframe windowtext'
  ).split(' ')
  const NAMED_SET = new Set(NAMED)
  const FUNCTIONS =
    /#[0-9a-f]{3,8}\b|\b(?:rgb|rgba|hsl|hsla|hwb|lab|lch|oklab|oklch|color|color-mix)\(/i
  // Properties whose values are words, not colours.
  const NOT_COLOURS = /^(font|font-family|content|src|grid-template-areas|animation-name)$/i

  /** Named colours in a declaration value (words that are not part of a url or a string). */
  function namedIn(value: string): string[] {
    const bare = value.replace(/url\([^)]*\)/gi, '').replace(/(['"]).*?\1/g, '')
    return (bare.match(/[a-z]+/gi) ?? []).filter((w) => NAMED_SET.has(w.toLowerCase()))
  }

  /** The offending colours in a stylesheet, ignoring :root (the tokens) and forced-colors rules. */
  function offenders(source: string): string[] {
    const rest = source
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/:root\s*\{[^}]*\}/, '')
      .replace(/@media\s*\(forced-colors:\s*active\)\s*\{(?:[^{}]*\{[^}]*\})*\s*\}/g, '')
      .replace(/@font-face\s*\{[^}]*\}/g, '')
    const bad = FUNCTIONS.test(rest) ? ['function or hex literal'] : []
    for (const m of rest.matchAll(/([a-z-]+)\s*:\s*([^;{}]+);/gi)) {
      if (m[1]?.startsWith('--') || NOT_COLOURS.test(m[1] ?? '')) continue
      bad.push(...namedIn(m[2] ?? '').map((w) => `${m[1]}: ${w}`))
    }
    return bad
  }

  it('index.css uses only var(--token) for colours, in any property', () => {
    expect(offenders(css)).toEqual([])
  })

  it('the guard catches what it should', () => {
    expect(offenders('a { box-shadow: 0 0 2px black; }')).toEqual(['box-shadow: black'])
    expect(offenders('a { color: rebeccapurple; }')).toEqual(['color: rebeccapurple'])
    expect(offenders('a { background: Canvas; }')).toEqual(['background: Canvas'])
    expect(offenders('a { color: #fff; }')).toHaveLength(1)
    expect(offenders('a { color: rgb(1 2 3); }')).toHaveLength(1)
    expect(offenders('a { color: transparent; border-color: currentColor; x: inherit; }')).toEqual(
      [],
    )
    expect(offenders('a { color: var(--text); font-family: Inter, system-ui; }')).toEqual([])
    expect(offenders('@media (forced-colors: active) { a { color: Highlight; } }')).toEqual([])
  })

  it('forced-colors rules mark the selected chip with system colours', () => {
    expect(css).toMatch(/@media \(forced-colors: active\)/)
    expect(css).toMatch(/background:\s*Highlight/)
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
    const styleValue =
      /\b(?:color|background|backgroundColor|borderColor|border|outline|fill|stroke|boxShadow|textShadow)\s*:\s*(['"`])(.*?)\1/g
    for (const file of files) {
      const source = readFileSync(file, 'utf8')
      expect(FUNCTIONS.test(source), file).toBe(false)
      for (const m of source.matchAll(styleValue)) {
        expect(namedIn(m[2] ?? ''), `${file}: ${m[0]}`).toEqual([])
      }
    }
  })
})
