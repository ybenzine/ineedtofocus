// The subscription link in the forms a calendar app wants (AC14.4).

export interface SubscribeLinks {
  /** For the copy field and for Google. */
  https: string
  /** Opens Apple Calendar (and most desktop calendar apps). */
  webcal: string
  /** Google's subscribe-by-URL page. */
  google: string
}

/**
 * `path` is what the server returned (`/api/calendar/<secret>.ics`), `origin` the address of
 * this app. Google's documented form is `https://calendar.google.com/calendar/r?cid=<url>`;
 * `cid` takes the feed's address, here its https form, URL-encoded.
 */
export function subscribeLinks(path: string, origin: string): SubscribeLinks {
  const https = `${origin}${path}`
  const webcal = https.replace(/^https?:/, 'webcal:')
  return {
    https,
    webcal,
    google: `https://calendar.google.com/calendar/r?cid=${encodeURIComponent(https)}`,
  }
}

const UNITS: [Intl.RelativeTimeFormatUnit, number][] = [
  ['day', 86_400_000],
  ['hour', 3_600_000],
  ['minute', 60_000],
]

/** "5 minutes ago", "3 hours ago", "2 days ago", "just now" (the server's time is to the minute). */
export function relativeTime(iso: string, now: number): string {
  const diff = now - Date.parse(iso)
  const format = new Intl.RelativeTimeFormat('en', { numeric: 'always' })
  for (const [unit, size] of UNITS) {
    if (diff >= size) return format.format(-Math.floor(diff / size), unit)
  }
  return 'just now'
}
