// Reads a pasted YouTube link (AC8.4, AC8.5). The rules match the server's check on
// `POST /api/youtube-links` (backend `_check_youtube_url`, decision log 2026-10-23): http or https
// only, on a known YouTube host, at most 2048 characters, no backslash, userinfo, whitespace or
// control characters, an ASCII host and only the default port. The server doesn't check the path;
// the client additionally needs a video or playlist id in it, or there is nothing to play.
//
// Unicode versions differ between browsers (ICU) and the server's Python, so a character one calls
// assigned the other may call unassigned. The client therefore percent-encodes every non-ASCII
// character before the link is saved or POSTed; the server only ever sees ASCII past the
// forbidden-character check, and a link that plays is a link that is saved.
//
// The player is always built from the parsed id, never from the pasted string.
// Test cases shared with the server live in `_docs/api/fixtures/youtube-links.json`.

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

/**
 * Whitespace and every control, format, private-use and unassigned character: the server refuses
 * anything Python's `isspace()` or `not isprintable()` flags, which is Unicode categories C and Z.
 */
const FORBIDDEN = /[\p{C}\p{Z}]/u

/** Percent-encodes (UTF-8) every non-ASCII character, as `encodeURI` would for those characters. */
function encodeNonAscii(value: string): string {
  return value.replace(/\P{ASCII}/gu, (char) => encodeURIComponent(char))
}

/** The link as the server will check it: trimmed, with `https://` added when no scheme was typed. */
export function normaliseYoutubeUrl(raw: string): string {
  const value = raw.trim()
  return value.includes('://') ? value : `https://${value}`
}

export type YoutubeCheck =
  | { ok: true; link: YoutubeLink }
  /** `invalid`: the server would refuse it. `no-id`: a YouTube link with nothing to play. */
  | { ok: false; reason: 'invalid' | 'no-id' }

const INVALID = { ok: false, reason: 'invalid' } as const

export function checkYoutubeLink(raw: string): YoutubeCheck {
  const normalised = normaliseYoutubeUrl(raw)
  if (normalised.includes('\\') || FORBIDDEN.test(normalised)) return INVALID
  // Non-ASCII is only left in the authority, where the ASCII check below refuses it.
  const pathStart = normalised.indexOf('://') + 3
  const authorityEnd = normalised.slice(pathStart).search(/[/?#]/u)
  const split = authorityEnd === -1 ? normalised.length : pathStart + authorityEnd
  const url = normalised.slice(0, split) + encodeNonAscii(normalised.slice(split))
  if (url.length > YOUTUBE_URL_MAX_LENGTH) return INVALID
  const authority = /^[a-zA-Z][a-zA-Z0-9+.-]*:\/\/([^/?#]*)/.exec(url)?.[1]
  if (authority === undefined || authority.includes('@') || !/^[\x21-\x7e]+$/.test(authority)) {
    return INVALID
  }
  // The host is read from the raw text: `URL` percent-decodes it, the server doesn't.
  const [rawHost = '', ...rest] = authority.split(':')
  if (rest.length > 1 || !YOUTUBE_HOSTS.has(rawHost.toLowerCase())) return INVALID
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    return INVALID
  }
  const defaultPort =
    parsed.protocol === 'https:' ? '443' : parsed.protocol === 'http:' ? '80' : null
  if (defaultPort === null) return INVALID
  // `URL` drops a default port, so any port left over is not the default one.
  if (parsed.port !== '' && parsed.port !== defaultPort) return INVALID
  if (parsed.username !== '' || parsed.password !== '') return INVALID

  const target = findTarget(parsed, rawHost.toLowerCase())
  return target ? { ok: true, link: { url, target } } : { ok: false, reason: 'no-id' }
}

/** Null when the server would refuse the link, or when it holds no video or playlist id. */
export function parseYoutubeLink(raw: string): YoutubeLink | null {
  const result = checkYoutubeLink(raw)
  return result.ok ? result.link : null
}

function findTarget(parsed: URL, host: string): YoutubeTarget | null {
  const path = parsed.pathname
  const video =
    host === 'youtu.be'
      ? (path.split('/')[1] ?? null)
      : (parsed.searchParams.get('v') ?? PATH_VIDEO.exec(path)?.[1] ?? null)
  // `/embed/videoseries?list=...` is YouTube's own playlist embed.
  if (video !== null && video !== 'videoseries' && VIDEO_ID.test(video))
    return { kind: 'video', id: video }
  const list = parsed.searchParams.get('list')
  if (list !== null && PLAYLIST_ID.test(list)) return { kind: 'playlist', id: list }
  return null
}

/** A label for the recent list. Plain text only: the pasted string is never an href. */
export function describeYoutubeLink(link: YoutubeLink): string {
  return `${link.target.kind === 'video' ? 'Video' : 'Playlist'} ${link.target.id}`
}
