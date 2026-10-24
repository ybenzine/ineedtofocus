// Pins the error colour tokens to WCAG AA (4.5:1) on every background they sit on (#149).
import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

// Vitest runs from frontend/ (the npm script's cwd).
const css = readFileSync(resolve(process.cwd(), 'src/index.css'), 'utf8')

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

function token(block: RegExp): string {
  const m = css.match(block)
  if (!m?.[1]) throw new Error(`token not found: ${block}`)
  return m[1]
}

const light = token(/:root\s*\{[^}]*--error:\s*(#[0-9a-f]{6})/i)
const dark = token(
  /prefers-color-scheme:\s*dark\)\s*\{\s*:root\s*\{[^}]*--error:\s*(#[0-9a-f]{6})/i,
)
const timer = token(/main\.dark-screen\s*\{\s*--error:\s*(#[0-9a-f]{6})/i)

describe('error colour contrast (#149)', () => {
  it('meets 4.5:1 on a white page', () => {
    expect(contrast(light, '#ffffff')).toBeGreaterThanOrEqual(4.5)
  })
  it('meets 4.5:1 on the dark canvas', () => {
    expect(contrast(dark, '#121212')).toBeGreaterThanOrEqual(4.5)
  })
  it('meets 4.5:1 on the dark timer screen', () => {
    expect(contrast(timer, '#0e1116')).toBeGreaterThanOrEqual(4.5)
  })
  it('uses the tokens everywhere else', () => {
    expect(css.match(/#ff8a80/gi)).toHaveLength(2)
    expect(css).toMatch(/\.field-error\s*\{\s*color:\s*var\(--error\)/)
  })
})
