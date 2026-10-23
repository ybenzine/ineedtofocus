// The recent YouTube links (AC8.6): GET and POST /api/youtube-links. Failures are quiet: the
// session and the player never depend on the list. Links are never logged.

export interface YoutubeLinksApi {
  list(signal?: AbortSignal): Promise<string[]>
  /** Records a link as just used and returns the updated list, newest first. */
  use(url: string): Promise<string[]>
}

function readLinks(body: unknown): string[] {
  const links = (body as { links?: unknown } | null)?.links
  if (!Array.isArray(links)) return []
  return links.flatMap((entry: unknown) => {
    const url = (entry as { url?: unknown } | null)?.url
    return typeof url === 'string' ? [url] : []
  })
}

async function call(method: 'GET' | 'POST', url?: string, signal?: AbortSignal): Promise<string[]> {
  const response = await fetch('/api/youtube-links', {
    method,
    credentials: 'same-origin',
    signal,
    headers: url === undefined ? undefined : { 'Content-Type': 'application/json' },
    body: url === undefined ? undefined : JSON.stringify({ url }),
  })
  if (!response.ok) throw new Error(`youtube-links ${response.status}`)
  return readLinks(await response.json())
}

export const httpYoutubeLinksApi: YoutubeLinksApi = {
  list: (signal) => call('GET', undefined, signal),
  use: (url) => call('POST', url),
}
