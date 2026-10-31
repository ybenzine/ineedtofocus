// End-of-session summary (F9): what was saved, with a link to the history (F10, built in #20).

import { useEffect, useRef, useState } from 'react'
import type { FinishOutcome } from '../timer/index.ts'
import { tagLabel } from '../setup/options.ts'
import { formatDuration } from './format.ts'

import { HISTORY_PATH } from '../nav/screens.ts'
import { AuthLink } from '../anonymous/AuthLink.tsx'

export { HISTORY_PATH }

export interface SessionSummaryProps {
  outcome: FinishOutcome
  /** True if the record couldn't be saved yet; it stays on the device and is retried. */
  recordPending?: boolean
  /**
   * The session is held for an anonymous user (#331): the prompt to save it replaces the link to
   * History, which an anonymous user has no data in.
   */
  savePrompt?: boolean
  /** The session was just saved into the account from the prompt (#331). */
  inAccount?: boolean
  onNewSession: () => void
  /** Switches to the History screen; without it the link is a plain `/history` link. */
  onViewHistory?: () => void
}

export default function SessionSummary({
  outcome,
  recordPending,
  savePrompt = false,
  inAccount = false,
  onNewSession,
  onViewHistory,
}: SessionSummaryProps) {
  const headingRef = useRef<HTMLHeadingElement>(null)
  useEffect(() => {
    headingRef.current?.focus()
  }, [])
  const [announce, setAnnounce] = useState(false)
  useEffect(() => {
    const id = setTimeout(() => setAnnounce(true), 100)
    return () => clearTimeout(id)
  }, [])
  return (
    <section className="summary" aria-labelledby="summary-title">
      {outcome.kind === 'saved' ? (
        <>
          <h1 id="summary-title" tabIndex={-1} ref={headingRef}>
            {outcome.record.status === 'completed' ? 'Session complete' : 'Session ended early'}
          </h1>
          <dl className="summary-details">
            <dt>Focus time</dt>
            <dd>{formatDuration(outcome.record.focusSeconds)}</dd>
            {outcome.record.pausedSeconds > 0 && (
              <>
                <dt>Paused</dt>
                <dd>{formatDuration(outcome.record.pausedSeconds)}</dd>
              </>
            )}
            {outcome.record.modeConfig.mode === 'pomodoro' && (
              <>
                <dt>Blocks completed</dt>
                <dd>
                  {outcome.record.blocksCompleted} of {outcome.record.modeConfig.blocks}
                </dd>
              </>
            )}
            <dt>Tag</dt>
            <dd className="timer-tag">{tagLabel(outcome.record.tag)}</dd>
            {outcome.record.goal && (
              <>
                <dt>Goal</dt>
                <dd>{outcome.record.goal}</dd>
              </>
            )}
          </dl>
          {recordPending && (
            <p role="status" className="field-hint">
              Not saved yet. It is kept on this device and will be saved automatically.
            </p>
          )}
          {inAccount && (
            // Mounted empty and filled afterwards, so a screen reader announces the change.
            <p role="status" className="field-hint">
              {inAccount && !recordPending && announce
                ? 'This session is now in your account.'
                : ''}
            </p>
          )}
          {savePrompt && (
            <p className="summary-prompt">
              <AuthLink form="signup" origin="prompt">
                Create an account
              </AuthLink>{' '}
              or{' '}
              <AuthLink form="signin" origin="prompt">
                log in
              </AuthLink>{' '}
              to save this session
            </p>
          )}
        </>
      ) : (
        <>
          <h1 id="summary-title" tabIndex={-1} ref={headingRef}>
            Session not saved
          </h1>
          <p>{outcome.message}</p>
        </>
      )}
      <div className="timer-controls">
        <button type="button" className="primary" onClick={onNewSession}>
          New session
        </button>
        {!savePrompt && (
          <a
            className="secondary link-button"
            href={HISTORY_PATH}
            onClick={(event) => {
              if (
                !onViewHistory ||
                event.button !== 0 ||
                event.metaKey ||
                event.ctrlKey ||
                event.shiftKey ||
                event.altKey
              )
                return
              event.preventDefault()
              onViewHistory()
            }}
          >
            View history
          </a>
        )}
      </div>
    </section>
  )
}
