// The app's top-level screens; there is no router. Add a screen by adding it to `SCREENS` and
// handling its id in `App`. Each screen has a URL so deep links work (`/history`, `/settings`).

export const SCREENS = [
  { id: 'setup', label: 'New session' },
  { id: 'history', label: 'History' },
  { id: 'settings', label: 'Settings' },
] as const

export type ScreenId = (typeof SCREENS)[number]['id']

export const HISTORY_PATH = '/history'
export const SETTINGS_PATH = '/settings'

/** The screen a URL path opens; anything else is the setup screen. */
export function screenFromPath(path: string): ScreenId {
  const clean = path.replace(/\/+$/, '')
  if (clean === HISTORY_PATH) return 'history'
  if (clean === SETTINGS_PATH) return 'settings'
  return 'setup'
}

export function pathForScreen(screen: ScreenId): string {
  if (screen === 'history') return HISTORY_PATH
  if (screen === 'settings') return SETTINGS_PATH
  return '/'
}
