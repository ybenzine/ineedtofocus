// Settings (F12): appearance, week start, alert and background volume, keep screen awake, default reminder.
// Every change is applied and saved on the device at once and synced when online (AC13.3).

import { useId } from 'react'
import SoundPreview from '../sounds/SoundPreview.tsx'
import type { AlertPlayer } from '../sounds/alerts.ts'
import { REMINDER_OPTIONS } from '../timer/index.ts'
import { wakeLockSupported } from '../timerscreen/wakeLock.ts'
import type { ReminderSetting, ThemeSetting } from './api.ts'
import { useSettingsState, useSettingsStore } from './SettingsContext.ts'
import AccountSection from '../auth/AccountSection.tsx'
import RangeInput from '../RangeInput.tsx'

const THEME_CHOICES: { value: ThemeSetting; label: string }[] = [
  { value: 'system', label: 'System (default)' },
  { value: 'dark', label: 'Dark' },
  { value: 'light', label: 'Light' },
]

const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday']

export default function SettingsScreen({ player }: { player: AlertPlayer }) {
  const store = useSettingsStore()
  const { values, pending, stalled } = useSettingsState()
  const id = useId()
  // Only when a send failed or the device is offline, not during every ordinary save.
  const waiting = Object.keys(pending).length > 0 && (stalled || !navigator.onLine)
  const canKeepAwake = wakeLockSupported()

  return (
    <div className="settings">
      <h1>Settings</h1>

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

      <SoundPreview player={player} volume={values.alert_volume} />

      <div className="field">
        <label htmlFor={`${id}-bg`}>Background audio volume</label>
        <RangeInput
          id={`${id}-bg`}
          min={0}
          max={100}
          step={1}
          value={values.background_volume}
          aria-valuetext={`${values.background_volume}%`}
          onChange={(event) => store.update({ background_volume: Number(event.target.value) })}
        />
      </div>

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

      <fieldset className="field">
        <legend>Appearance</legend>
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

      <p role="status" className="field-hint">
        {waiting ? "Saved on this device. It will sync when you're back online." : ''}
      </p>

      <AccountSection />
    </div>
  )
}
