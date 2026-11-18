// The list of recent YouTube links (AC8.6), shared by the timer screen and New session (#325).
// On New session each link also has a remove control with an inline confirm (AC8.9, #490).

import { useEffect, useId, useRef, useState } from 'react'
import type { YoutubeLink } from './youtubeLink.ts'
import type { RecentItem } from './youtubeRecent.ts'
import YoutubeLabel from './YoutubeLabel.tsx'

export interface RecentLinkListProps {
  recent: RecentItem[]
  onChoose: (link: YoutubeLink) => void
  /** The url of the link now chosen, marked as pressed. */
  selectedUrl?: string
  /** Show the YouTube mark on each link (default). */
  showIcon?: boolean
  /** Removes a link from the account's recent links; true once it is gone. Omit for no control. */
  onRemove?: (link: YoutubeLink) => Promise<boolean>
  /** Called after a link was removed, to put focus somewhere that still exists. */
  onRemoved?: () => void
  /** Whether there is a connection: removing needs one. */
  online?: boolean
}

export const REMOVE_ERROR = 'Couldn’t remove the link. Try again.'
export const REMOVE_OFFLINE_HINT = 'Removing a recent link needs a connection.'

function X() {
  return (
    <svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true" focusable="false">
      <path
        d="M3.5 3.5l9 9m0-9l-9 9"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.75"
        strokeLinecap="round"
      />
    </svg>
  )
}

export default function RecentLinkList({
  recent,
  onChoose,
  selectedUrl,
  showIcon = true,
  onRemove,
  onRemoved,
  online = true,
}: RecentLinkListProps) {
  const id = useId()
  const [removing, setRemoving] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState<{ kind: 'status' | 'error'; text: string } | null>(null)
  const removeButtons = useRef(new Map<string, HTMLButtonElement>())

  // The url whose remove control should take focus once it is back in place of the confirm.
  const refocus = useRef<string | null>(null)
  useEffect(() => {
    if (refocus.current === null) return
    const button = removeButtons.current.get(refocus.current)
    if (button) {
      button.focus()
      refocus.current = null
    }
  })

  // The status and error stay mounted when the last link goes, so they are still announced.
  if (recent.length === 0 && !onRemove) return null

  function cancel(url: string) {
    refocus.current = url
    setRemoving(null)
  }

  async function confirm(item: RecentItem) {
    if (!onRemove) return
    setBusy(true)
    const done = await onRemove(item.link)
    setBusy(false)
    setRemoving(null)
    if (done) {
      refocus.current = null
      setMessage({ kind: 'status', text: 'Removed from your recent links.' })
      onRemoved?.()
    } else {
      setMessage({ kind: 'error', text: REMOVE_ERROR })
      refocus.current = item.link.url
    }
  }

  return (
    <div className="youtube-recent-wrap">
      {recent.length > 0 && (
        <ul className="youtube-recent" aria-label="Recent YouTube links">
          {recent.map((item) => {
            const name = item.title ?? item.link.url
            return (
              <li key={item.link.url}>
                {onRemove && removing === item.link.url ? (
                  <div
                    role="group"
                    aria-label={`Remove ${name}`}
                    className="youtube-recent-confirm"
                    onKeyDown={(event) => {
                      if (event.key === 'Escape') {
                        // Escape never reaches the sheet from here; while the request runs it waits.
                        event.stopPropagation()
                        if (!busy) cancel(item.link.url)
                      }
                    }}
                  >
                    <p>Remove {name} from your recent links?</p>
                    <div className="tag-actions">
                      <button
                        type="button"
                        autoFocus
                        aria-disabled={busy || undefined}
                        onClick={() => {
                          if (!busy) cancel(item.link.url)
                        }}
                      >
                        Cancel
                      </button>
                      <button
                        type="button"
                        className="primary"
                        aria-disabled={busy || undefined}
                        onClick={() => {
                          if (!busy) void confirm(item)
                        }}
                      >
                        Remove
                      </button>
                    </div>
                  </div>
                ) : (
                  <div className="youtube-recent-row">
                    <button
                      type="button"
                      className="secondary"
                      aria-pressed={
                        selectedUrl === undefined ? undefined : selectedUrl === item.link.url
                      }
                      onClick={() => onChoose(item.link)}
                    >
                      <YoutubeLabel
                        kind={item.link.target.kind}
                        title={item.title}
                        showIcon={showIcon}
                      />
                    </button>
                    {onRemove && (
                      <button
                        type="button"
                        className="youtube-recent-remove"
                        aria-label={`Remove ${name} from recent links`}
                        aria-describedby={online ? undefined : `${id}-offline`}
                        disabled={!online}
                        ref={(node) => {
                          if (node) removeButtons.current.set(item.link.url, node)
                          else removeButtons.current.delete(item.link.url)
                        }}
                        onClick={() => {
                          setMessage(null)
                          setRemoving(item.link.url)
                        }}
                      >
                        <X />
                      </button>
                    )}
                  </div>
                )}
              </li>
            )
          })}
        </ul>
      )}
      {onRemove && !online && (
        <p id={`${id}-offline`} className="field-hint">
          {REMOVE_OFFLINE_HINT}
        </p>
      )}
      <p role="status" className="field-hint">
        {message?.kind === 'status' ? message.text : ''}
      </p>
      {message?.kind === 'error' && (
        <p role="alert" className="field-hint field-error">
          {message.text}
        </p>
      )}
    </div>
  )
}
