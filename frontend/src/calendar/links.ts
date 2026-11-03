// The subscription link in the forms a calendar app wants (AC14.4).

export interface SubscribeLinks {
  /** For the copy field. */
  https: string
  /** Opens Apple Calendar (and most desktop calendar apps). */
  webcal: string
  /** Google's subscribe-by-URL page. */
  google: string
}

/**
 * `path` is what the server returned (`/api/calendar/<secret>.ics`), `origin` the address of
 * this app. Google's subscribe-by-URL link is `https://calendar.google.com/calendar/u/0/r?cid=<url>`
 * where `<url>` is the feed's `webcal://` address, URL-encoded: Google refuses the https form with
 * "unable to add calendar" (#453). The same form add-to-calendar-button ships.
 */
export function subscribeLinks(path: string, origin: string): SubscribeLinks {
  const https = `${origin}${path}`
  const webcal = https.replace(/^https?:/, 'webcal:')
  return {
    https,
    webcal,
    google: `https://calendar.google.com/calendar/u/0/r?cid=${encodeURIComponent(webcal)}`,
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
