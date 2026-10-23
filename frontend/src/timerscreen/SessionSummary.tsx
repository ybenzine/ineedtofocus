// End-of-session summary (F9): what was saved, with a link to the history (F10, built in #20).

import type { FinishOutcome } from '../timer/index.ts'
import { formatDuration } from './format.ts'

/** The history screen's route (#20). */
export const HISTORY_PATH = '/history'

export interface SessionSummaryProps {
  outcome: FinishOutcome
  /** True if the record couldn't be saved yet; it stays on the device and is retried. */
  recordPending?: boolean
  onNewSession: () => void
}

export default function SessionSummary({
  outcome,
  recordPending,
  onNewSession,
}: SessionSummaryProps) {
  return (
    <section className="summary" aria-labelledby="summary-title">
      {outcome.kind === 'saved' ? (
        <>
          <h1 id="summary-title">
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
            <dd className="timer-tag">{outcome.record.tag}</dd>
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
        </>
      ) : (
        <>
          <h1 id="summary-title">Session not saved</h1>
          <p>{outcome.message}</p>
        </>
      )}
      <div className="timer-controls">
        <button type="button" className="primary" onClick={onNewSession}>
          New session
        </button>
        <a className="secondary link-button" href={HISTORY_PATH}>
          View history
        </a>
      </div>
    </section>
  )
}
