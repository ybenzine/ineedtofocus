// The two sheets of the New session screen: Tag & goal (AC7.10) and Sound (AC8.8).

import { useId, type RefObject } from 'react'
import type { Tag } from '../timer/index.ts'
import { onAppleMobile, SETUP_SILENT_HINT } from '../sounds/appleMobile.ts'
import { OfflineRainSuggestion } from '../sounds/AudioControls.tsx'
import YoutubeSetup from '../sounds/YoutubeSetup.tsx'
import type { YoutubeLinksApi } from '../sounds/youtubeLinksApi.ts'
import { TagDot } from '../tags/TagName.tsx'
import type { TagInfo } from '../tags/view.ts'
import { CheckIcon } from './icons.tsx'
import {
  AUDIO_LABELS,
  AUDIO_SOURCES,
  GOAL_MAX_LENGTH,
  cleanGoal,
  type AudioSource,
} from './options.ts'
import Sheet from './Sheet.tsx'

export function TagGoalSheet({
  tags,
  tag,
  onTag,
  goal,
  onGoal,
  goalRef,
  focusGoal,
  onManageTags,
  onClose,
  returnFocusTo,
}: {
  tags: readonly TagInfo[]
  tag: Tag
  onTag: (tag: Tag) => void
  goal: string
  onGoal: (goal: string) => void
  goalRef: RefObject<HTMLInputElement | null>
  /** Opened from the Goal row: the goal field takes focus. */
  focusGoal: boolean
  /** Set only for a signed-in user (AC7.9). */
  onManageTags: (() => void) | undefined
  onClose: () => void
  returnFocusTo: RefObject<HTMLElement | null>
}) {
  const id = useId()
  return (
    <Sheet
      title="Tag & goal"
      onClose={onClose}
      returnFocusTo={returnFocusTo}
      initialFocus={focusGoal ? goalRef : undefined}
    >
      <div className="sheet-section">
        <div className="sheet-label-row">
          <span id={`${id}-tag`} className="caption">
            Tag
          </span>
          {onManageTags && (
            <a
              className="sheet-link"
              href="/settings"
              onClick={(event) => {
                if (event.metaKey || event.ctrlKey || event.shiftKey || event.button !== 0) return
                event.preventDefault()
                onManageTags()
              }}
            >
              Manage tags
            </a>
          )}
        </div>
        <fieldset className="pills tag-pills" aria-labelledby={`${id}-tag`}>
          {tags.map((t) => (
            <label key={t.id} className="pill">
              <input
                type="radio"
                name={`${id}-tag`}
                checked={tag === t.id}
                onChange={() => onTag(t.id)}
              />
              <TagDot color={t.color} />
              <span className="tag-name-text">{t.name}</span>
              <span className="pill-check">
                <CheckIcon />
              </span>
            </label>
          ))}
        </fieldset>
      </div>
      <div className="sheet-section">
        <div className="sheet-label-row">
          <label htmlFor={`${id}-goal`} className="caption">
            Goal
          </label>
          <span id={`${id}-optional`} className="sheet-optional">
            Optional
          </span>
        </div>
        <input
          ref={goalRef}
          id={`${id}-goal`}
          type="text"
          className="sheet-goal"
          maxLength={GOAL_MAX_LENGTH}
          autoComplete="off"
          placeholder="What are you focusing on?"
          value={goal}
          aria-describedby={`${id}-optional ${id}-count`}
          onChange={(event) => onGoal(cleanGoal(event.target.value))}
          onKeyDown={(event) => {
            // Enter closes the sheet; it never starts the session behind it.
            if (event.key === 'Enter') {
              event.preventDefault()
              onClose()
            }
          }}
        />
        <p id={`${id}-count`} className="field-hint sheet-count">
          {goal.length}/{GOAL_MAX_LENGTH}
        </p>
      </div>
    </Sheet>
  )
}

export function SoundSheet({
  audio,
  onAudio,
  youtubeText,
  onYoutubeText,
  youtubeApi,
  online,
  onClose,
  returnFocusTo,
}: {
  audio: AudioSource
  onAudio: (audio: AudioSource) => void
  youtubeText: string
  onYoutubeText: (text: string) => void
  youtubeApi: YoutubeLinksApi | undefined
  online: boolean
  onClose: () => void
  returnFocusTo: RefObject<HTMLElement | null>
}) {
  const id = useId()
  const hintId = `${id}-youtube-hint`
  return (
    <Sheet title="Sound" onClose={onClose} returnFocusTo={returnFocusTo}>
      <fieldset className="pills sound-pills">
        <legend className="sr-only">Background audio</legend>
        {AUDIO_SOURCES.map((a) => (
          <label key={a} className="pill">
            <input
              type="radio"
              name={`${id}-audio`}
              checked={audio === a}
              onChange={() => onAudio(a)}
            />
            <span>{AUDIO_LABELS[a]}</span>
          </label>
        ))}
      </fieldset>
      {audio === 'rain' && onAppleMobile() && <p className="field-hint">{SETUP_SILENT_HINT}</p>}
      {audio === 'youtube' && online && (
        <YoutubeSetup
          text={youtubeText}
          onTextChange={onYoutubeText}
          hintId={hintId}
          api={youtubeApi}
        />
      )}
      {audio === 'youtube' && !online && (
        <div id={hintId}>
          <OfflineRainSuggestion onUseRain={() => onAudio('rain')} />
        </div>
      )}
    </Sheet>
  )
}
