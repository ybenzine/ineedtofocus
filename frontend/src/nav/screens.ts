// The app's top-level screens; there is no router. Add a screen by adding it to `SCREENS` and
// handling its id in `App`. Each screen has a URL so deep links work (`/history`).

export const SCREENS = [
  { id: 'setup', label: 'New session' },
  { id: 'history', label: 'History' },
] as const

export type ScreenId = (typeof SCREENS)[number]['id']

export const HISTORY_PATH = '/history'

/** The screen a URL path opens; anything else is the setup screen. */
export function screenFromPath(path: string): ScreenId {
  return path.replace(/\/+$/, '') === HISTORY_PATH ? 'history' : 'setup'
}

export function pathForScreen(screen: ScreenId): string {
  return screen === 'history' ? HISTORY_PATH : '/'
}
