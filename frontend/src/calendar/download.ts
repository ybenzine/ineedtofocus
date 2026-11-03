// Hands a generated .ics file to the user (AC14.7). Nothing is uploaded: the file is made in
// memory from the session on the device, so it works offline.

export function isIos(): boolean {
  const nav = navigator
  return (
    /iP(hone|ad|od)/.test(nav.userAgent) || (nav.platform === 'MacIntel' && nav.maxTouchPoints > 1)
  )
}

/** A phone or tablet. Google Calendar can't subscribe to a feed by URL from one (#453). */
export function isMobile(): boolean {
  return isIos() || /Android/i.test(navigator.userAgent)
}

/** Saves `text` as `fileName` through a hidden download link. Nothing is opened. */
export function saveIcs(text: string, fileName: string): void {
  const url = icsBlobUrl(text)
  const link = document.createElement('a')
  link.href = url
  link.download = fileName
  link.hidden = true
  document.body.append(link)
  link.click()
  link.remove()
  setTimeout(() => URL.revokeObjectURL(url), 60_000)
}

/** A blob URL for `text` made ahead of the tap, so the link can be activated by the tap itself. */
export function icsBlobUrl(text: string): string {
  return URL.createObjectURL(new Blob([text], { type: 'text/calendar;charset=utf-8' }))
}

/**
 * Where the server serves one session as an .ics (#454), for iOS. A `data:` or `blob:` link does
 * nothing there (#451 was not enough, even installed), but a same-origin https link the user
 * taps shows the Calendar "Add event" sheet. The user's time zone names the file's local times.
 */
export function sessionIcsPath(id: string, timeZone: string): string {
  return `/api/calendar/session/${encodeURIComponent(id)}.ics?tz=${encodeURIComponent(timeZone)}`
}
