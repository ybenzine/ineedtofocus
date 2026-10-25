import { render, screen } from '@testing-library/react'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import RangeInput from './RangeInput.tsx'
import { SETTINGS_KEY } from './settings/store.ts'
import { applyTheme } from './theme.ts'

const root = document.documentElement

beforeEach(() => {
  document.head.innerHTML = '<meta name="theme-color" content="#000000">'
})
afterEach(() => {
  root.removeAttribute('data-theme')
  root.style.removeProperty('--bg')
  localStorage.clear()
})

describe('applyTheme', () => {
  it('sets data-theme for Dark and Light and clears it for System', () => {
    applyTheme('light')
    expect(root).toHaveAttribute('data-theme', 'light')
    applyTheme('dark')
    expect(root).toHaveAttribute('data-theme', 'dark')
    applyTheme('system')
    expect(root).not.toHaveAttribute('data-theme')
  })

  it('points the browser chrome at the page background', () => {
    root.style.setProperty('--bg', ' #eeeefa ')
    applyTheme('light')
    expect(document.querySelector('meta[name="theme-color"]')).toHaveAttribute('content', '#eeeefa')
  })
})

describe('theme-init.js (runs before first paint)', () => {
  const script = readFileSync(resolve(process.cwd(), 'public/theme-init.js'), 'utf8')
  const run = () => new Function(script)()

  it('reads the saved theme from the same key the settings store writes', () => {
    for (const theme of ['dark', 'light']) {
      localStorage.setItem(SETTINGS_KEY, JSON.stringify({ owner: 'u', values: { theme } }))
      root.removeAttribute('data-theme')
      run()
      expect(root).toHaveAttribute('data-theme', theme)
    }
  })

  it.each([
    ['nothing saved', null],
    ['system', JSON.stringify({ values: { theme: 'system' } })],
    ['an unknown value', JSON.stringify({ values: { theme: 'sepia' } })],
    ['unreadable JSON', '{nope'],
  ])('leaves the choice to the device for %s', (_name, saved) => {
    if (saved !== null) localStorage.setItem(SETTINGS_KEY, saved)
    run()
    expect(root).not.toHaveAttribute('data-theme')
  })
})

describe('RangeInput', () => {
  it('passes the value to the track as a 0-1 fill', () => {
    render(<RangeInput aria-label="Volume" min={0} max={100} value={25} onChange={() => {}} />)
    expect(screen.getByRole('slider').style.getPropertyValue('--fill')).toBe('0.25')
  })

  it('handles a range that does not start at zero, and clamps', () => {
    render(<RangeInput aria-label="A" min={10} max={20} value={15} onChange={() => {}} />)
    render(<RangeInput aria-label="B" min={0} max={10} value={50} onChange={() => {}} />)
    expect(screen.getByLabelText('A').style.getPropertyValue('--fill')).toBe('0.5')
    expect(screen.getByLabelText('B').style.getPropertyValue('--fill')).toBe('1')
  })
})
