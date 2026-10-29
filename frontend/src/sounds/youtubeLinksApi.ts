// The recent YouTube links (AC8.6): GET and POST /api/youtube-links. Failures are quiet: the
// session and the player never depend on the list. Links and titles are never logged.

export interface RecentLink {
  url: string
  /** What the player reported when the link was last played; null until then. */
  title: string | null
}

export interface YoutubeLinksApi {
  list(signal?: AbortSignal): Promise<RecentLink[]>
  /**
   * Records a link as just used and returns the updated list, newest first. A title is sent once
   * the player knows it; without one the server keeps the title it has.
   */
  use(url: string, title?: string): Promise<RecentLink[]>
}

/** The server's cap on a title; the player's can be longer. */
export const TITLE_SEND_MAX = 200

function readLinks(body: unknown): RecentLink[] {
  const links = (body as { links?: unknown } | null)?.links
  if (!Array.isArray(links)) return []
  return links.flatMap((entry: unknown) => {
    const { url, title } = (entry ?? {}) as { url?: unknown; title?: unknown }
    return typeof url === 'string'
      ? [{ url, title: typeof title === 'string' && title !== '' ? title : null }]
      : []
  })
}

async function call(
  method: 'GET' | 'POST',
  payload?: { url: string; title?: string },
  signal?: AbortSignal,
): Promise<RecentLink[]> {
  const response = await fetch('/api/youtube-links', {
    method,
    credentials: 'same-origin',
    signal,
    headers: payload === undefined ? undefined : { 'Content-Type': 'application/json' },
    body: payload === undefined ? undefined : JSON.stringify(payload),
  })
  if (!response.ok) throw new Error(`youtube-links ${response.status}`)
  return readLinks(await response.json())
}

export const httpYoutubeLinksApi: YoutubeLinksApi = {
  list: (signal) => call('GET', undefined, signal),
  use: (url, title) => {
    // Counted in code points, which is what the server counts; longer titles are cut to fit.
    const sent =
      title === undefined ? undefined : Array.from(title).slice(0, TITLE_SEND_MAX).join('')
    return call('POST', sent ? { url, title: sent } : { url })
  },
}
