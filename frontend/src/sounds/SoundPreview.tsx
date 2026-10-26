// Preview buttons and the alert volume slider (AC5.2, AC5.3). Reusable: the Settings screen
// (#22) places it. The volume is the alert volume only, separate from background audio.

import { useId, useState } from 'react'
import { onAppleMobile, SETTINGS_SILENT_HINT } from './appleMobile.ts'
import { type AlertPlayer } from './alerts.ts'
import RangeInput from '../RangeInput.tsx'

export interface SoundPreviewProps {
  /** Owns the alert volume, so the slider and the playback can't disagree. */
  player: AlertPlayer
  /** The current alert volume, when it can change under the slider (a synced value arriving). */
  volume?: number
}

export default function SoundPreview({ player, volume }: SoundPreviewProps) {
  const [local, setLevel] = useState(() => player.volume)
  const level = volume ?? local
  const hintId = useId()
  // Silent mode mutes Web Audio on iPhone/iPad and can't be detected, so say so (#307).
  const hint = onAppleMobile()

  function preview(name: 'chime' | 'bell') {
    // A button press is a user gesture: unlock first, then play once the context is running.
    void player.unlock().then(() => player.play(name))
  }

  return (
    <section aria-labelledby="alert-sounds-heading">
      <h2 id="alert-sounds-heading">Alert sounds</h2>
      <label>
        Alert volume
        <RangeInput
          min={0}
          max={100}
          step={1}
          value={level}
          aria-valuetext={`${level}%`}
          onChange={(event) => {
            const next = Number(event.target.value)
            setLevel(next)
            player.setVolume(next)
          }}
        />
      </label>
      <button
        type="button"
        aria-describedby={hint ? hintId : undefined}
        onClick={() => preview('chime')}
      >
        Preview chime
      </button>
      <button
        type="button"
        aria-describedby={hint ? hintId : undefined}
        onClick={() => preview('bell')}
      >
        Preview bell
      </button>
      {hint && (
        <p id={hintId} className="field-hint">
          {SETTINGS_SILENT_HINT}
        </p>
      )}
    </section>
  )
}
