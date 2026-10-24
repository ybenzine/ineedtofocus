// The timer screen's background audio controls (F8). Rain follows the timer: it plays while the
// timer runs (through breaks too), pauses with it and stops when the session's screen goes away
// (AC8.2). YouTube (#18) follows the same rules in its own visible player; offline it only offers
// to switch to Rain (AC8.7).

import { useEffect, useId } from 'react'
import { useSettingsState } from '../settings/SettingsContext.ts'
import type { AudioSource } from '../setup/options.ts'
import type { RainPlayer } from './rain.ts'
import { useOnline } from './useOnline.ts'
import type { YoutubeLinkStore } from './audioSource.ts'
import YoutubeControls from './YoutubeControls.tsx'
import type { LoadYoutubeApi } from './ytApi.ts'
import type { YoutubeLinksApi } from './youtubeLinksApi.ts'

/** AC8.7: YouTube needs a connection, rain doesn't. */
export function OfflineRainSuggestion({ onUseRain }: { onUseRain: () => void }) {
  return (
    <div className="field-hint" role="status">
      <p>You are offline, so YouTube can't play. Rain works offline.</p>
      <button type="button" className="secondary" onClick={onUseRain}>
        Use Rain instead
      </button>
    </div>
  )
}

export interface AudioControlsProps {
  source: AudioSource
  /** The timer is paused. */
  paused: boolean
  rain: RainPlayer
  onSourceChange: (source: AudioSource) => void
  /** Injectable for tests. */
  youtube?: {
    linkStore?: YoutubeLinkStore
    api?: YoutubeLinksApi
    loadApi?: LoadYoutubeApi
  }
}

export default function AudioControls({
  source,
  paused,
  rain,
  onSourceChange,
  youtube,
}: AudioControlsProps) {
  const online = useOnline()
  const volumeId = useId()
  // The same value the Settings screen edits: moving one moves the other.
  const { values } = useSettingsState()
  const volume = values.background_volume
  const shouldPlay = source === 'rain' && !paused

  useEffect(() => {
    if (shouldPlay) void rain.play()
    else rain.pause()
  }, [shouldPlay, rain])

  // The session screen going away (stop, completion, another tab ending it) ends the rain.
  useEffect(() => () => rain.stop(), [rain])

  return (
    <>
      {source === 'rain' && (
        <div className="timer-volume">
          <label htmlFor={volumeId}>Rain volume</label>
          <input
            id={volumeId}
            type="range"
            min={0}
            max={100}
            value={volume}
            onChange={(event) => {
              rain.setVolume(Number(event.target.value))
            }}
          />
        </div>
      )}
      {source === 'youtube' && online && <YoutubeControls paused={paused} {...youtube} />}
      {source === 'youtube' && !online && (
        <OfflineRainSuggestion onUseRain={() => onSourceChange('rain')} />
      )}
    </>
  )
}
