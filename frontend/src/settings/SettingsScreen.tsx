// Settings (F12), in themed sections (AC12.9), each a card with a level-2 heading that opens and
// closes it (AC12.10): Appearance, Audio, Timer, Tags, History (signed in), Calendar, Account
// (signed in). Appearance, Audio, Timer and History start open; Tags, Calendar and Account start
// closed. The open state is plain component state, so it isn't remembered once Settings is left.
// A closed section stays mounted (see SettingsSection). The sync note sits under the title,
// outside every section. Every change is applied and saved on the device at once and synced
// when online (AC13.3).

import { useEffect, useId, useRef, useState } from 'react'
import SoundPreview from '../sounds/SoundPreview.tsx'
import type { AlertPlayer } from '../sounds/alerts.ts'
import { REMINDER_OPTIONS, type TimerController } from '../timer/index.ts'
import { wakeLockSupported } from '../timerscreen/wakeLock.ts'
import type { ReminderSetting, ThemeSetting } from './api.ts'
import { useSettingsState, useSettingsStore } from './SettingsContext.ts'
import { useSoundLevels, useSoundLevelsStore } from './SoundLevelsContext.ts'
import TagsSection from '../tags/TagsSection.tsx'
import CalendarSection from '../calendar/CalendarSection.tsx'
import type { SessionStore } from '../sync/sessionStore.ts'
import AccountSection from '../auth/AccountSection.tsx'
import SettingsSection from './SettingsSection.tsx'
import RangeInput from '../RangeInput.tsx'
import { useAnonymous } from '../anonymous/AnonymousContext.ts'
import { ANONYMOUS_SETTINGS_NOTE } from '../anonymous/AnonymousScreens.tsx'

const THEME_CHOICES: { value: ThemeSetting; label: string }[] = [
  { value: 'system', label: 'System (default)' },
  { value: 'dark', label: 'Dark' },
  { value: 'light', label: 'Light' },
]

const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday']

export default function SettingsScreen({
  player,
  controller,
  sessions = null,
  openTags = false,
}: {
  player: AlertPlayer
  controller?: TimerController
  /** The device's sessions, for the calendar preview's latest session. */
  sessions?: SessionStore | null
  /** Manage tags (AC7.10): open with Tags open and in view; the other sections keep their defaults. */
  openTags?: boolean
}) {
  const store = useSettingsStore()
  const { values, pending, stalled } = useSettingsState()
  const levelsStore = useSoundLevelsStore()
  const levels = useSoundLevels()
  const id = useId()
  // Without an account: device-only settings, no History, no Account section (#331).
  const anonymous = useAnonymous() !== null
  // Only when a send failed or the device is offline, not during every ordinary save.
  const waiting = !anonymous && Object.keys(pending).length > 0 && (stalled || !navigator.onLine)
  const canKeepAwake = wakeLockSupported()
  // Read once: the sections own their open state from then on.
  const [tagsFirst] = useState(openTags)
  const tagsRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (tagsFirst) tagsRef.current?.scrollIntoView?.()
  }, [tagsFirst])

  return (
    <div className="settings">
      <h1>Settings</h1>
      <p role="status" className="field-hint">
        {waiting ? "Saved on this device. It will sync when you're back online." : ''}
      </p>
      {anonymous && <p className="field-hint">{ANONYMOUS_SETTINGS_NOTE}</p>}

      <SettingsSection title="Appearance" defaultOpen>
        <fieldset className="field">
          <legend>Theme</legend>
          <div className="choices">
            {THEME_CHOICES.map(({ value, label }) => (
              <label key={value} className="choice">
                <input
                  type="radio"
                  name={`${id}-theme`}
                  value={value}
                  checked={values.theme === value}
                  onChange={() => store.update({ theme: value })}
                />
                {label}
              </label>
            ))}
          </div>
          <p className="field-hint">
            System follows this device&apos;s light or dark setting. The timer is always dark.
          </p>
        </fieldset>
      </SettingsSection>

      <SettingsSection title="Audio" defaultOpen>
        <SoundPreview player={player} volume={levels.alert} />

        <div className="field">
          <label htmlFor={`${id}-bg`}>Background audio volume</label>
          <RangeInput
            id={`${id}-bg`}
            min={0}
            max={100}
            step={1}
            value={levels.background}
            aria-valuetext={`${levels.background}%`}
            onChange={(event) => levelsStore.set('background', Number(event.target.value))}
          />
          <p className="field-hint">Sound levels are saved on this device only.</p>
        </div>

        <div className="field">
          <label>
            <input
              type="checkbox"
              checked={values.pause_audio_on_breaks}
              onChange={(event) => store.update({ pause_audio_on_breaks: event.target.checked })}
            />{' '}
            Pause background audio during Pomodoro breaks
          </label>
        </div>
      </SettingsSection>

      <SettingsSection title="Timer" defaultOpen>
        <div className="field">
          <label>
            <input
              type="checkbox"
              checked={canKeepAwake && values.keep_screen_awake}
              disabled={!canKeepAwake}
              onChange={(event) => store.update({ keep_screen_awake: event.target.checked })}
            />{' '}
            Keep screen awake during sessions
          </label>
          {!canKeepAwake && (
            <p className="field-hint">This browser can&apos;t keep the screen awake.</p>
          )}
        </div>

        <div className="field">
          <label htmlFor={`${id}-reminder`}>Default reminder interval (unlimited timer)</label>
          <select
            id={`${id}-reminder`}
            value={values.default_reminder_minutes ?? 'off'}
            onChange={(event) =>
              store.update({
                default_reminder_minutes:
                  event.target.value === 'off'
                    ? null
                    : (Number(event.target.value) as ReminderSetting),
              })
            }
          >
            <option value="off">Off</option>
            {REMINDER_OPTIONS.map((minutes) => (
              <option key={minutes} value={minutes}>
                Every {minutes} min
              </option>
            ))}
          </select>
        </div>
      </SettingsSection>

      <div ref={tagsRef}>
        <SettingsSection title="Tags" defaultOpen={tagsFirst}>
          <TagsSection embedded />
        </SettingsSection>
      </div>

      {!anonymous && (
        <SettingsSection title="History" defaultOpen>
          <div className="field">
            <label htmlFor={`${id}-week`}>Week starts on</label>
            <select
              id={`${id}-week`}
              value={values.week_start_day}
              aria-describedby={`${id}-week-hint`}
              onChange={(event) => store.update({ week_start_day: Number(event.target.value) })}
            >
              {DAYS.map((day, index) => (
                <option key={day} value={index}>
                  {day}
                </option>
              ))}
            </select>
            <p id={`${id}-week-hint`} className="field-hint">
              Days and weeks follow this device&apos;s time zone.
            </p>
          </div>
        </SettingsSection>
      )}

      <SettingsSection title="Calendar" defaultOpen={false}>
        <CalendarSection sessions={sessions} embedded />
      </SettingsSection>

      {!anonymous && (
        <SettingsSection title="Account" defaultOpen={false}>
          <AccountSection controller={controller} embedded />
        </SettingsSection>
      )}
    </div>
  )
}
