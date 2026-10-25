// Types and loader for the YouTube IFrame Player API (loaded from YouTube, never bundled).

/** The slice of the IFrame Player API this app uses. */
export interface YtPlayer {
  playVideo(): void
  pauseVideo(): void
  stopVideo(): void
  seekTo(seconds: number, allowSeekAhead: boolean): void
  setVolume(volume: number): void
  setLoop(loop: boolean): void
  nextVideo(): void
  getPlaylist(): string[] | null | undefined
  destroy(): void
}

export interface YtPlayerOptions {
  width: string
  height: string
  host: string
  videoId?: string
  playerVars: Record<string, string | number>
  events: {
    onReady: () => void
    onStateChange: (event: { data: number }) => void
    onError: (event: { data: number }) => void
  }
}

export interface YtNamespace {
  Player: new (element: HTMLElement, options: YtPlayerOptions) => YtPlayer
}

export type LoadYoutubeApi = () => Promise<YtNamespace>

export const YT_ENDED = 0
export const YT_PLAYING = 1
/** Video not found (100), embedding not allowed (101, 150): only that item is lost. */
export const SKIPPABLE_ERRORS = [100, 101, 150]
/** Used when the player can't say how many items the playlist has. */
export const UNKNOWN_PLAYLIST_LENGTH = 3
export const API_TIMEOUT_MS = 15_000
export const YOUTUBE_API_SCRIPT = 'https://www.youtube.com/iframe_api'

declare global {
  interface Window {
    YT?: YtNamespace
    onYouTubeIframeAPIReady?: () => void
  }
}

let apiPromise: Promise<YtNamespace> | null = null

/** Loads the IFrame Player API from YouTube once. A failed load may be retried. */
export const loadYoutubeApi: LoadYoutubeApi = () => {
  if (window.YT?.Player) return Promise.resolve(window.YT)
  apiPromise ??= new Promise<YtNamespace>((resolve, reject) => {
    const previous = window.onYouTubeIframeAPIReady
    // A content blocker can stop the widget scripts after `iframe_api` itself has loaded.
    const script = document.createElement('script')
    const timer = window.setTimeout(() => {
      // Take both back, so a retry adds one script and one handler rather than a second of each.
      script.remove()
      window.onYouTubeIframeAPIReady = previous
      apiPromise = null
      reject(new Error('YouTube API timed out'))
    }, API_TIMEOUT_MS)
    window.onYouTubeIframeAPIReady = () => {
      window.clearTimeout(timer)
      previous?.()
      if (window.YT?.Player) resolve(window.YT)
      else reject(new Error('YouTube API missing'))
    }
    script.src = YOUTUBE_API_SCRIPT
    script.async = true
    script.onerror = () => {
      window.clearTimeout(timer)
      script.remove()
      window.onYouTubeIframeAPIReady = previous
      apiPromise = null
      reject(new Error('YouTube API blocked'))
    }
    document.head.appendChild(script)
  })
  return apiPromise
}

export const PLAYER_ERROR_MESSAGE =
  "This video can't be played. It may be unavailable, private or not allowed to be embedded. Your session carries on."
export const SKIPPED_ITEM_MESSAGE = "One video in the playlist can't be played, so it was skipped."
export const PLAYER_LOAD_MESSAGE =
  "The YouTube player couldn't load. Check your connection or try Rain. Your session carries on."
