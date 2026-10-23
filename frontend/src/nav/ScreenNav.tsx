import { SCREENS, type ScreenId } from './screens.ts'

// Buttons for moving between the top-level screens (see screens.ts). Never shown over a timer.

export interface ScreenNavProps {
  current: ScreenId
  onNavigate: (screen: ScreenId) => void
}

export default function ScreenNav({ current, onNavigate }: ScreenNavProps) {
  return (
    <nav aria-label="Screens" className="screen-nav">
      {SCREENS.map((screen) => (
        <button
          key={screen.id}
          type="button"
          aria-current={screen.id === current ? 'page' : undefined}
          onClick={() => onNavigate(screen.id)}
        >
          {screen.label}
        </button>
      ))}
    </nav>
  )
}
