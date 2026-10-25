import { render, screen } from '@testing-library/react'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import RangeInput from './RangeInput.tsx'
import { USER_KEY } from './auth/localData.ts'
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

  const signedInAs = (id: string) => localStorage.setItem(USER_KEY, JSON.stringify({ id }))

  it('reads the signed-in user theme from the keys the app writes', () => {
    signedInAs('u')
    for (const theme of ['dark', 'light']) {
      localStorage.setItem(SETTINGS_KEY, JSON.stringify({ owner: 'u', values: { theme } }))
      root.removeAttribute('data-theme')
      run()
      expect(root).toHaveAttribute('data-theme', theme)
    }
  })

  it('ignores a settings copy that belongs to someone else', () => {
    signedInAs('u2')
    localStorage.setItem(SETTINGS_KEY, JSON.stringify({ owner: 'u1', values: { theme: 'light' } }))
    run()
    expect(root).not.toHaveAttribute('data-theme')
  })

  it('ignores the settings copy when nobody is signed in on the device', () => {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify({ owner: 'u', values: { theme: 'light' } }))
    run()
    expect(root).not.toHaveAttribute('data-theme')
    localStorage.setItem(SETTINGS_KEY, JSON.stringify({ owner: null, values: { theme: 'dark' } }))
    signedInAs('u')
    run()
    expect(root).not.toHaveAttribute('data-theme')
  })

  it.each([
    ['nothing saved', null],
    ['system', JSON.stringify({ owner: 'u', values: { theme: 'system' } })],
    ['an unknown value', JSON.stringify({ owner: 'u', values: { theme: 'sepia' } })],
    ['unreadable JSON', '{nope'],
  ])('leaves the choice to the device for %s', (_name, saved) => {
    signedInAs('u')
    if (saved !== null) localStorage.setItem(SETTINGS_KEY, saved)
    run()
    expect(root).not.toHaveAttribute('data-theme')
  })

  it('is loaded by index.html in <head>, as a blocking script before the app bundle', () => {
    const html = readFileSync(resolve(process.cwd(), 'index.html'), 'utf8')
    const head = html.slice(html.indexOf('<head>'), html.indexOf('</head>'))
    const init = head.search(/<script src="\/theme-init\.js"><\/script>/)
    expect(init).toBeGreaterThan(-1) // in <head>, not async, defer or a module
    expect(init).toBeLessThan(html.indexOf('/src/main.tsx'))
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
