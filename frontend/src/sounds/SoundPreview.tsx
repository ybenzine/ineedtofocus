// Preview buttons and the alert volume slider (AC5.2, AC5.3). Reusable: the Settings screen
// (#22) places it. The volume is the alert volume only, separate from background audio.

import { useState } from 'react'
import { type AlertPlayer } from './alerts.ts'

export interface SoundPreviewProps {
  /** Owns the alert volume, so the slider and the playback can't disagree. */
  player: AlertPlayer
}

export default function SoundPreview({ player }: SoundPreviewProps) {
  const [level, setLevel] = useState(() => player.volume)

  function preview(name: 'chime' | 'bell') {
    // A button press is a user gesture: unlock first, then play once the context is running.
    void player.unlock().then(() => player.play(name))
  }

  return (
    <section aria-labelledby="alert-sounds-heading">
      <h2 id="alert-sounds-heading">Alert sounds</h2>
      <label>
        Alert volume
        <input
          type="range"
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
      <button type="button" onClick={() => preview('chime')}>
        Preview chime
      </button>
      <button type="button" onClick={() => preview('bell')}>
        Preview bell
      </button>
    </section>
  )
}
