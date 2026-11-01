import type { ReactNode } from 'react'
import AccountBar from '../auth/AccountBar.tsx'
import type { TimerController } from '../timer/index.ts'
import ScreenNav from './ScreenNav.tsx'
import type { ScreenId } from './screens.ts'
import { useWideScreen } from './useWideScreen.ts'

/**
 * The frame of every screen that has navigation (#406): a compact header (wordmark, account or
 * Log in; on wide screens also the text tabs), the content, and on phones a bottom tab bar. Focus
 * order is header, content, tab bar. Never used over a running timer or the session summary.
 */
export default function AppShell({
  current,
  controller,
  onNavigate,
  mainClassName,
  holdsUpdate = false,
  children,
}: {
  current: ScreenId
  controller: TimerController
  onNavigate: (screen: ScreenId) => void
  mainClassName?: string
  /** A setup in progress is kept (#407): the automatic update waits, whichever screen this is. */
  holdsUpdate?: boolean
  children: ReactNode
}) {
  const wide = useWideScreen()
  return (
    <>
      <header className="app-header">
        <div className="app-header-inner">
          <div className="wordmark">
            <svg aria-hidden="true" width="22" height="22" viewBox="0 0 24 24" fill="none">
              <circle className="wordmark-track" cx="12" cy="12" r="9" />
              <path className="wordmark-arc" d="M12 3a9 9 0 0 1 9 9" />
            </svg>
            <span>I Need To Focus</span>
          </div>
          {wide && <ScreenNav variant="tabs" current={current} onNavigate={onNavigate} />}
          <AccountBar controller={controller} />
        </div>
      </header>
      <main className={mainClassName}>
        {holdsUpdate && <span hidden data-holds-update="" />}
        {children}
      </main>
      {!wide && <ScreenNav variant="bar" current={current} onNavigate={onNavigate} />}
    </>
  )
}
