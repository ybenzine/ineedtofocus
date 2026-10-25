// Applies the colour theme setting (#214) to the page.
//
// "System" leaves <html> alone so `prefers-color-scheme` decides in index.css; "Dark" and "Light"
// set `data-theme`. public/theme-init.js does the same from the device copy of the settings
// before the first paint; this keeps it in step afterwards (a change in Settings, a different
// signed-in user, the device switching between light and dark).

import { useEffect } from 'react'
import type { ThemeSetting } from './settings/api.ts'

export function applyTheme(theme: ThemeSetting, root: HTMLElement = document.documentElement) {
  if (theme === 'system') root.removeAttribute('data-theme')
  else root.setAttribute('data-theme', theme)
  syncThemeColor(root)
}

/** Points the browser chrome (address bar, status bar) at the page background actually showing. */
export function syncThemeColor(root: HTMLElement = document.documentElement) {
  const bg = getComputedStyle(root).getPropertyValue('--bg').trim()
  if (!bg) return
  for (const meta of document.querySelectorAll<HTMLMetaElement>('meta[name="theme-color"]')) {
    meta.setAttribute('content', bg)
  }
}

/**
 * Keeps the page in the chosen theme. `focusScreen` is true while the always-dark timer shows,
 * so the browser chrome follows it too.
 */
export function useTheme(theme: ThemeSetting, focusScreen: boolean): void {
  useEffect(() => {
    applyTheme(theme)
    if (theme !== 'system' || typeof window.matchMedia !== 'function') return
    const query = window.matchMedia('(prefers-color-scheme: light)')
    const onChange = () => syncThemeColor()
    query.addEventListener?.('change', onChange)
    return () => query.removeEventListener?.('change', onChange)
  }, [theme, focusScreen])
}
