import type { ReactNode } from 'react'
import { SCREENS, type ScreenId } from './screens.ts'

// The screens (see screens.ts) as a bottom tab bar on phones or text tabs in the header on wide
// screens. Never shown over a timer. The tab bar's icons are inline strokes in `currentColor`.

export interface ScreenNavProps {
  current: ScreenId
  onNavigate: (screen: ScreenId) => void
  /** `bar`: icon and label tabs fixed to the bottom; `tabs`: text tabs in the header. */
  variant: 'bar' | 'tabs'
}

const ICONS: Record<ScreenId, ReactNode> = {
  setup: (
    <>
      <circle cx="12" cy="12" r="9" />
      <path d="M12 8v8M8 12h8" />
    </>
  ),
  history: <path d="M3 21h18M6 17v-5M11 17V7M16 17v-8M21 17v-3" />,
  archive: (
    <>
      <rect x="3" y="4" width="18" height="5" rx="1" />
      <path d="M5 9v10a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1V9M10 13h4" />
    </>
  ),
  settings: (
    <>
      <path d="M4 6h9M17 6h3M4 12h3M11 12h9M4 18h11M19 18h1" />
      <circle cx="15" cy="6" r="2" />
      <circle cx="9" cy="12" r="2" />
      <circle cx="17" cy="18" r="2" />
    </>
  ),
}

const SHORT_LABELS: Record<ScreenId, string> = {
  setup: 'New',
  history: 'History',
  archive: 'Archive',
  settings: 'Settings',
}

export default function ScreenNav({ current, onNavigate, variant }: ScreenNavProps) {
  return (
    <nav aria-label="Screens" className={variant === 'bar' ? 'tab-bar' : 'screen-nav'}>
      {SCREENS.map((screen) => (
        <button
          key={screen.id}
          type="button"
          aria-current={screen.id === current ? 'page' : undefined}
          // The bar shows "New"; the name keeps the full label (it contains the visible text).
          aria-label={variant === 'bar' ? screen.label : undefined}
          onClick={() => onNavigate(screen.id)}
        >
          {variant === 'bar' ? (
            <>
              <svg
                aria-hidden="true"
                width="22"
                height="22"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.9"
                strokeLinecap="round"
                strokeLinejoin="round"
              >
                {ICONS[screen.id]}
              </svg>
              <span>{SHORT_LABELS[screen.id]}</span>
            </>
          ) : (
            screen.label
          )}
        </button>
      ))}
    </nav>
  )
}
