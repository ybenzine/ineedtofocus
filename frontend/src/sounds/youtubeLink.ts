// Reads a pasted YouTube link (AC8.4, AC8.5). The rules match the server's check on
// `POST /api/youtube-links` (backend `_check_youtube_url`, decision log 2026-10-23): http or https
// only, on a known YouTube host, at most 2048 characters, no backslash, userinfo, whitespace or
// control characters, an ASCII host and only the default port. The server doesn't check the path;
// the client additionally needs a video or playlist id in it, or there is nothing to play.
//
// The player is always built from the parsed id, never from the pasted string.

export const YOUTUBE_HOSTS: ReadonlySet<string> = new Set([
  'youtube.com',
  'www.youtube.com',
  'm.youtube.com',
  'music.youtube.com',
  'youtu.be',
  'youtube-nocookie.com',
  'www.youtube-nocookie.com',
])

export const YOUTUBE_URL_MAX_LENGTH = 2048

export type YoutubeTarget = { kind: 'video'; id: string } | { kind: 'playlist'; id: string }

export interface YoutubeLink {
  /** The normalised link (scheme added), the form saved to the recent list. */
  url: string
  target: YoutubeTarget
}

const VIDEO_ID = /^[A-Za-z0-9_-]{11}$/
const PLAYLIST_ID = /^[A-Za-z0-9_-]{12,64}$/
const PATH_VIDEO = /^\/(?:embed|shorts|live|v)\/([^/]+)/

/** Whitespace, control and invisible characters (the server refuses anything not printable). */
const FORBIDDEN = new RegExp(
  // eslint-disable-next-line no-control-regex
  '[\\s\\u0000-\\u001f\\u007f-\\u009f\\u200b-\\u200f\\u2028-\\u202f\\u2060\\ufeff]',
)

/** The link as the server will check it: trimmed, with `https://` added when no scheme was typed. */
export function normaliseYoutubeUrl(raw: string): string {
  const value = raw.trim()
  return value.includes('://') ? value : `https://${value}`
}

/** Null when the server would refuse the link, or when it holds no video or playlist id. */
export function parseYoutubeLink(raw: string): YoutubeLink | null {
  const url = normaliseYoutubeUrl(raw)
  if (url.length > YOUTUBE_URL_MAX_LENGTH || url.includes('\\') || FORBIDDEN.test(url)) {
    return null
  }
  const authority = /^[a-zA-Z][a-zA-Z0-9+.-]*:\/\/([^/?#]*)/.exec(url)?.[1]
  if (authority === undefined || authority.includes('@') || !/^[\x21-\x7e]+$/.test(authority)) {
    return null
  }
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    return null
  }
  const defaultPort =
    parsed.protocol === 'https:' ? '443' : parsed.protocol === 'http:' ? '80' : null
  if (defaultPort === null || !YOUTUBE_HOSTS.has(parsed.hostname.toLowerCase())) return null
  // `URL` drops a default port, so any port left over is not the default one.
  if (parsed.port !== '' && parsed.port !== defaultPort) return null
  if (parsed.username !== '' || parsed.password !== '') return null

  const target = findTarget(parsed)
  return target ? { url, target } : null
}

function findTarget(parsed: URL): YoutubeTarget | null {
  const path = parsed.pathname
  const video =
    parsed.hostname.toLowerCase() === 'youtu.be'
      ? (path.split('/')[1] ?? null)
      : (parsed.searchParams.get('v') ?? PATH_VIDEO.exec(path)?.[1] ?? null)
  if (video !== null && VIDEO_ID.test(video)) return { kind: 'video', id: video }
  const list = parsed.searchParams.get('list')
  if (list !== null && PLAYLIST_ID.test(list)) return { kind: 'playlist', id: list }
  return null
}

/** A label for the recent list. Plain text only: the pasted string is never an href. */
export function describeYoutubeLink(link: YoutubeLink): string {
  return `${link.target.kind === 'video' ? 'Video' : 'Playlist'} ${link.target.id}`
}
