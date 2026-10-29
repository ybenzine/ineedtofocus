// Pins the design tokens: the dark "Dusk 5°" set (#213) and the light set that mirrors it (#214).
// Checks the values, the WCAG contrast of every text and control pair in BOTH sets (text 4.5:1,
// control borders 3:1), the shared hue family, how the sets are selected, and that no colour
// literal lives outside the token blocks.
import { describe, expect, it } from 'vitest'
import { readdirSync, readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

// Resolved from this file, not the cwd, so it runs from frontend/ and from the repo root.
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const css = readFileSync(resolve(root, 'src/index.css'), 'utf8')

function rgb(hex: string): [number, number, number] {
  return [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255) as [number, number, number]
}

function luminance(hex: string): number {
  const [r, g, b] = rgb(hex).map((c) =>
    c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4,
  ) as [number, number, number]
  return 0.2126 * r + 0.7152 * g + 0.0722 * b
}

function contrast(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [number, number]
  return (hi + 0.05) / (lo + 0.05)
}

/** HSL hue in degrees, or null for greys. */
function hue(hex: string): number | null {
  const [r, g, b] = rgb(hex)
  const max = Math.max(r, g, b)
  const d = max - Math.min(r, g, b)
  if (d === 0) return null
  const h = max === r ? ((g - b) / d) % 6 : max === g ? (b - r) / d + 2 : (r - g) / d + 4
  return Math.round((h * 60 + 360) % 360)
}

type TokenSet = Record<string, string>

function tk(set: TokenSet, name: string): string {
  const value = set[name]
  if (!value) throw new Error(`token --${name} missing`)
  return value
}

/** Every token block: a rule whose selector starts at `:root`. */
const blocks = [...css.replace(/\/\*[\s\S]*?\*\//g, '').matchAll(/(:root[^{}]*)\{([^}]*)\}/g)].map(
  (m) => {
    const tokens: TokenSet = {}
    for (const t of (m[2] as string).matchAll(/--([a-z-]+):\s*(#[0-9a-f]{6})\b/gi)) {
      tokens[t[1] as string] = (t[2] as string).toLowerCase()
    }
    return {
      selector: (m[1] as string).trim(),
      tokens,
      scheme: (m[2] as string).match(/color-scheme:\s*(\w+)\s*;/)?.[1],
    }
  },
)

function block(selector: string) {
  const found = blocks.find((b) => b.selector === selector)
  if (!found) throw new Error(`no ${selector} block in index.css`)
  return found
}

const DARK_SELECTORS = [':root', ':root:has(main.focus-screen)']
const LIGHT_SELECTORS = [":root:not([data-theme='dark'])", ":root[data-theme='light']"]

const DARK: TokenSet = block(':root').tokens
const LIGHT: TokenSet = block(":root[data-theme='light']").tokens

const NAMES = [
  'bg',
  'surface',
  'border',
  'control-border',
  'text',
  'muted',
  'accent',
  'accent-hover',
  'on-accent',
  'error',
]

describe('design tokens (#213, #214)', () => {
  it('defines exactly the Dusk 5° dark palette', () => {
    expect(DARK).toEqual({
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
  })

  it('defines the light palette', () => {
    expect(LIGHT).toEqual({
      bg: '#eeeefa',
      surface: '#fbfbff',
      border: '#d3d3ec',
      'control-border': '#6c6cae',
      text: '#14143a',
      muted: '#4a4a7c',
      accent: '#4146d1',
      'accent-hover': '#2a2ea8',
      'on-accent': '#fafaff',
      error: '#b3261e',
    })
  })

  it('the light set mirrors every token of the dark set', () => {
    expect(Object.keys(DARK).sort()).toEqual([...NAMES].sort())
    expect(Object.keys(LIGHT).sort()).toEqual([...NAMES].sort())
  })

  it('every place a set is applied carries the same values', () => {
    for (const selector of DARK_SELECTORS) expect(block(selector).tokens, selector).toEqual(DARK)
    for (const selector of LIGHT_SELECTORS) expect(block(selector).tokens, selector).toEqual(LIGHT)
    expect(blocks).toHaveLength(DARK_SELECTORS.length + LIGHT_SELECTORS.length)
  })

  it('declares the matching color-scheme with each set', () => {
    for (const selector of DARK_SELECTORS) expect(block(selector).scheme, selector).toBe('dark')
    for (const selector of LIGHT_SELECTORS) expect(block(selector).scheme, selector).toBe('light')
  })

  it('the light set follows the device only while the user has not chosen Dark', () => {
    expect(css).toMatch(
      /@media \(prefers-color-scheme: light\)\s*\{\s*:root:not\(\[data-theme='dark'\]\)\s*\{/,
    )
  })

  it('the timer and summary screens stay dark in every mode (AC9.1)', () => {
    // After the light rules, and more specific than all of them, so it always wins.
    const forced = css.indexOf(':root:has(main.focus-screen) {')
    expect(forced).toBeGreaterThan(css.indexOf(":root[data-theme='light'] {"))
  })

  it('keeps the blue-leaning hue family in both sets (errors are red)', () => {
    for (const [name, set] of [
      ['dark', DARK],
      ['light', LIGHT],
    ] as const) {
      for (const [token, value] of Object.entries(set)) {
        if (token === 'error') continue
        const h = hue(value)
        if (h === null) continue // a grey has no hue
        expect(h, `${name} --${token}`).toBeGreaterThanOrEqual(225)
        expect(h, `${name} --${token}`).toBeLessThanOrEqual(255)
      }
    }
  })

  it('sets the page chrome to the background token', () => {
    const html = readFileSync(resolve(root, 'index.html'), 'utf8')
    expect(html).toContain(`content="${DARK['bg']}" media="(prefers-color-scheme: dark)"`)
    expect(html).toContain(`content="${LIGHT['bg']}" media="(prefers-color-scheme: light)"`)
    const vite = readFileSync(resolve(root, 'vite.config.ts'), 'utf8')
    // The installed app's splash and title bar can't switch, so they stay on the dark reference.
    expect(vite).toContain(`background_color: '${DARK['bg']}'`)
    expect(vite).toContain(`theme_color: '${DARK['bg']}'`)
  })
})

describe.each([
  ['dark', DARK],
  ['light', LIGHT],
])('%s set: text contrast is at least 4.5:1 (WCAG AA)', (_name, set) => {
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
    expect(contrast(set[fg] as string, set[bg] as string)).toBeGreaterThanOrEqual(4.5)
  })
})

describe('the dark ratios match the design table (#213)', () => {
  it('matches', () => {
    expect(contrast(tk(DARK, 'text'), tk(DARK, 'bg'))).toBeCloseTo(15.8, 0)
    expect(contrast(tk(DARK, 'muted'), tk(DARK, 'bg'))).toBeCloseTo(8.3, 0)
    expect(contrast(tk(DARK, 'accent'), tk(DARK, 'bg'))).toBeCloseTo(7.3, 0)
    expect(contrast(tk(DARK, 'on-accent'), tk(DARK, 'accent'))).toBeCloseTo(7.4, 0)
    expect(contrast(tk(DARK, 'error'), tk(DARK, 'bg'))).toBeCloseTo(8.1, 0)
  })
})

describe.each([
  ['dark', DARK],
  ['light', LIGHT],
])('%s set: control borders and focus are at least 3:1 (WCAG 1.4.11)', (_name, set) => {
  it.each(['bg', 'surface'])('control border on %s', (bg) => {
    expect(contrast(tk(set, 'control-border'), tk(set, bg))).toBeGreaterThanOrEqual(3)
  })
  it.each(['bg', 'surface'])('the focus ring (accent) on %s', (bg) => {
    expect(contrast(tk(set, 'accent'), tk(set, bg))).toBeGreaterThanOrEqual(3)
  })
})

describe('the focus ring', () => {
  it('is drawn in the accent', () => {
    expect(css).toMatch(/:focus-visible\s*\{\s*outline:\s*3px solid var\(--accent\)/)
  })
})

describe('no colour literals outside the token blocks (#213, #214)', () => {
  // Every CSS named colour plus the system colours; `transparent`, `currentColor` and `inherit` are fine.
  const NAMED =
    'aliceblue antiquewhite aqua aquamarine azure beige bisque black blanchedalmond blue blueviolet brown burlywood cadetblue chartreuse chocolate coral cornflowerblue cornsilk crimson cyan darkblue darkcyan darkgoldenrod darkgray darkgreen darkgrey darkkhaki darkmagenta darkolivegreen darkorange darkorchid darkred darksalmon darkseagreen darkslateblue darkslategray darkslategrey darkturquoise darkviolet deeppink deepskyblue dimgray dimgrey dodgerblue firebrick floralwhite forestgreen fuchsia gainsboro ghostwhite gold goldenrod gray green greenyellow grey honeydew hotpink indianred indigo ivory khaki lavender lavenderblush lawngreen lemonchiffon lightblue lightcoral lightcyan lightgoldenrodyellow lightgray lightgreen lightgrey lightpink lightsalmon lightseagreen lightskyblue lightslategray lightslategrey lightsteelblue lightyellow lime limegreen linen magenta maroon mediumaquamarine mediumblue mediumorchid mediumpurple mediumseagreen mediumslateblue mediumspringgreen mediumturquoise mediumvioletred midnightblue mintcream mistyrose moccasin navajowhite navy oldlace olive olivedrab orange orangered orchid palegoldenrod palegreen paleturquoise palevioletred papayawhip peachpuff peru pink plum powderblue purple rebeccapurple red rosybrown royalblue saddlebrown salmon sandybrown seagreen seashell sienna silver skyblue slateblue slategray slategrey snow springgreen steelblue tan teal thistle tomato turquoise violet wheat white whitesmoke yellow yellowgreen'.split(
      ' ',
    )
  const SYSTEM =
    'accentcolor accentcolortext activetext buttonborder buttonface buttontext canvas canvastext field fieldtext graytext highlight highlighttext linktext mark marktext selecteditem selecteditemtext visitedtext activeborder activecaption appworkspace background captiontext inactiveborder inactivecaption inactivecaptiontext infobackground infotext menu menutext scrollbar threeddarkshadow threedface threedhighlight threedlightshadow threedshadow window windowframe windowtext'.split(
      ' ',
    )
  const NAMED_SET = new Set([...NAMED, ...SYSTEM])
  const NAMED_ONLY = new Set(NAMED)
  const FUNCTIONS =
    /#[0-9a-f]{3,8}\b|\b(?:rgb|rgba|hsl|hsla|hwb|lab|lch|oklab|oklch|color|color-mix)\(/i
  // Properties whose values are words, not colours.
  const NOT_COLOURS =
    /^(font|font-family|content|src|grid-template-areas|animation-name|transition|transition-property|will-change)$/i

  /** Named colours in a declaration value (words that are not part of a url or a string). */
  function namedIn(value: string, set: Set<string> = NAMED_SET): string[] {
    const bare = value.replace(/url\([^)]*\)/gi, '').replace(/(['"]).*?\1/g, '')
    return (bare.match(/[a-z]+/gi) ?? []).filter((w) => set.has(w.toLowerCase()))
  }

  const FORCED = /@media\s*\(forced-colors:\s*active\)\s*\{((?:[^{}]*\{[^}]*\})*)\s*\}/g

  function declarations(source: string): [string, string][] {
    return [...source.matchAll(/([a-z-]+)\s*:\s*([^;{}]+);/gi)]
      .map((m): [string, string] => [m[1] ?? '', m[2] ?? ''])
      .filter(([prop]) => !prop.startsWith('--') && !NOT_COLOURS.test(prop))
  }

  /**
   * The offending colours in a stylesheet. :root (the tokens) is exempt. Inside a forced-colors
   * block only CSS system colours are allowed: hex, functions and named colours still fail there.
   */
  function offenders(source: string): string[] {
    const clean = source
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/:root[^{}]*\{[^}]*\}/g, '')
      .replace(/@font-face\s*\{[^}]*\}/g, '')
    const forced = [...clean.matchAll(FORCED)].map((m) => m[1] ?? '').join('\n')
    const rest = clean.replace(FORCED, '')
    const bad: string[] = []
    if (FUNCTIONS.test(rest)) bad.push('function or hex literal')
    if (FUNCTIONS.test(forced)) bad.push('forced-colors: function or hex literal')
    for (const [prop, value] of declarations(rest)) {
      bad.push(...namedIn(value).map((w) => `${prop}: ${w}`))
    }
    for (const [prop, value] of declarations(forced)) {
      bad.push(...namedIn(value, NAMED_ONLY).map((w) => `forced-colors ${prop}: ${w}`))
    }
    return bad
  }

  it('index.css uses only var(--token) for colours, in any property', () => {
    expect(offenders(css)).toEqual([])
  })

  /** Source without block and line comments, where issue references like (#120) look like hex colours. */
  function withoutComments(source: string): string {
    return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[\s;,{}()])\/\/.*$/gm, '$1')
  }

  it('ignores issue references in comments but still catches real colours in code', () => {
    const comments = '// see #120 and (#214)\n/* fixes #152 */\nconst a = 1 // after code #131\n'
    expect(FUNCTIONS.test(withoutComments(comments))).toBe(false)
    expect(FUNCTIONS.test(withoutComments("const style = { color: '#fff' } // #120"))).toBe(true)
    expect(FUNCTIONS.test(withoutComments("const c = '#123'\n// #120"))).toBe(true)
    expect(FUNCTIONS.test(withoutComments("const u = 'https://x.example/#abc'"))).toBe(true)
    expect(FUNCTIONS.test(withoutComments('const c = rgb(1 2 3) // note'))).toBe(true)
  })

  it('the CSS guard ignores issue references in comments but catches real hex colours', () => {
    expect(offenders('/* see #120 */ a { color: var(--text); }')).toEqual([])
    expect(offenders('a { color: #120; } /* #120 */')).toHaveLength(1)
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
    expect(offenders('@media (forced-colors: active) { a { color: #fff; } }')).toHaveLength(1)
    expect(offenders('@media (forced-colors: active) { a { color: red; } }')).toEqual([
      'forced-colors color: red',
    ])
    expect(offenders('a { transition: background 0.2s, color 0.2s; }')).toEqual([])
  })

  it('forced-colors rules mark the selected chip with system colours', () => {
    expect(css).toMatch(/@media \(forced-colors: active\)/)
    expect(css).toMatch(/background:\s*Highlight/)
  })

  it('SVG colour attributes use only currentColor, none, a url() or the YouTube brand colours (#326)', () => {
    // The brand colours are pinned, for the YouTube icon only: YouTube red and white.
    const BRAND: Record<string, string[]> = {
      'sounds/YoutubeLabel.tsx': ['red', 'white'],
    }
    const attribute =
      /\b(?:fill|stroke|stop-color|stopColor|flood-color|floodColor|color)=(?:"([^"]*)"|\{'([^']*)'\})/g
    const SAFE = new Set(['none', 'currentcolor', 'transparent', 'inherit'])
    const offending: string[] = []
    const walk = (dir: string) => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const path = join(dir, entry.name)
        if (entry.isDirectory()) walk(path)
        else if (/\.tsx$/.test(entry.name) && !/\.test\.tsx$/.test(entry.name)) {
          const rel = path.slice(resolve(root, 'src').length + 1)
          for (const m of withoutComments(readFileSync(path, 'utf8')).matchAll(attribute)) {
            const value = (m[1] ?? m[2] ?? '').trim().toLowerCase()
            if (SAFE.has(value) || value.startsWith('url(')) continue
            if (BRAND[rel]?.includes(value)) continue
            offending.push(`${rel}: ${m[0]}`)
          }
        }
      }
    }
    walk(resolve(root, 'src'))
    expect(offending).toEqual([])
    // The scan sees what it should.
    const probe = '<svg><rect fill="#123456" /><path fill="blue" stroke={\'tomato\'} /></svg>'
    expect([...probe.matchAll(attribute)]).toHaveLength(3)
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
      const source = withoutComments(readFileSync(file, 'utf8'))
      expect(FUNCTIONS.test(source), file).toBe(false)
      for (const m of source.matchAll(styleValue)) {
        expect(namedIn(m[2] ?? ''), `${file}: ${m[0]}`).toEqual([])
      }
    }
  })
})

// #328: the History view switcher sits on the page background in both themes; it used to be a
// --surface slab that stood out in light mode.
describe('History view switcher background (#328)', () => {
  const rule = (sel: string) =>
    css.match(new RegExp(`(?:^|\\n)${sel.replace('.', '\\.')}\\s*\\{([^}]*)\\}`))?.[1] ?? ''

  it('.history-views uses the page token, one rule for every theme', () => {
    expect(rule('.history-views')).toMatch(/background:\s*var\(--bg\)/)
    expect(css).not.toMatch(/\[data-theme[^{]*\{[^}]*\.history-views/)
  })

  it('.history-tags has no background of its own', () => {
    expect(rule('.history-tags')).not.toMatch(/background/)
  })

  it('text and the selected pill stay AA on the page background in both sets', () => {
    for (const set of [DARK, LIGHT]) {
      expect(contrast(set['text'] as string, set['bg'] as string)).toBeGreaterThanOrEqual(4.5)
      expect(contrast(set['on-accent'] as string, set['accent'] as string)).toBeGreaterThanOrEqual(
        4.5,
      )
      expect(contrast(set['accent'] as string, set['bg'] as string)).toBeGreaterThanOrEqual(3)
    }
  })
})
