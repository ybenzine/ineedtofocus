// Types and loader for the YouTube IFrame Player API (loaded from YouTube, never bundled).

/** The slice of the IFrame Player API this app uses. */
export interface YtPlayer {
  playVideo(): void
  pauseVideo(): void
  stopVideo(): void
  seekTo(seconds: number, allowSeekAhead: boolean): void
  setVolume(volume: number): void
  setLoop(loop: boolean): void
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
    window.onYouTubeIframeAPIReady = () => {
      previous?.()
      if (window.YT?.Player) resolve(window.YT)
      else reject(new Error('YouTube API missing'))
    }
    const script = document.createElement('script')
    script.src = YOUTUBE_API_SCRIPT
    script.async = true
    script.onerror = () => {
      script.remove()
      apiPromise = null
      reject(new Error('YouTube API blocked'))
    }
    document.head.appendChild(script)
  })
  return apiPromise
}

export const PLAYER_ERROR_MESSAGE =
  "This video can't be played. It may be unavailable, private or not allowed to be embedded. Your session carries on."
export const PLAYER_LOAD_MESSAGE =
  "The YouTube player couldn't load. Check your connection or try Rain. Your session carries on."
