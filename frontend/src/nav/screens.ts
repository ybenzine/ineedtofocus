// The app's top-level screens; there is no router yet. Add a screen by adding it to `SCREENS`
// (the History screen, #20, does that) and handling its id in `App`.

export const SCREENS = [
  { id: 'setup', label: 'New session' },
  { id: 'settings', label: 'Settings' },
] as const

export type ScreenId = (typeof SCREENS)[number]['id']
