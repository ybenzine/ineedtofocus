// Settings (F12): week start, alert and background volume, keep screen awake, default reminder.
// Every change is applied and saved on the device at once and synced when online (AC13.3).

import { useId } from 'react'
import SoundPreview from '../sounds/SoundPreview.tsx'
import type { AlertPlayer } from '../sounds/alerts.ts'
import { REMINDER_OPTIONS } from '../timer/index.ts'
import { wakeLockSupported } from '../timerscreen/wakeLock.ts'
import type { ReminderSetting } from './api.ts'
import { useSettingsState, useSettingsStore } from './SettingsContext.ts'

const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday']

export default function SettingsScreen({ player }: { player: AlertPlayer }) {
  const store = useSettingsStore()
  const { values, pending } = useSettingsState()
  const id = useId()
  const waiting = Object.keys(pending).length > 0
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

      <SoundPreview player={player} />

      <div className="field">
        <label htmlFor={`${id}-bg`}>Background audio volume</label>
        <input
          id={`${id}-bg`}
          type="range"
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

      <p role="status" className="field-hint">
        {waiting ? "Saved on this device. It will sync when you're back online." : ''}
      </p>
    </div>
  )
}
