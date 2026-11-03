// Hands a generated .ics file to the user (AC14.7). Nothing is uploaded: the file is made in
// memory from the session on the device, so it works offline.

export function isIos(): boolean {
  const nav = navigator
  return (
    /iP(hone|ad|od)/.test(nav.userAgent) || (nav.platform === 'MacIntel' && nav.maxTouchPoints > 1)
  )
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
 * A `data:` URL for `text`, for iOS (#451). In the installed Home Screen app a `blob:` link opened
 * in a new tab is handed to Safari, which can't read the app's blob (WebKit bug 197441); a data
 * URL carries the file itself, so a same-tab navigation to it shows the Calendar "Add event"
 * sheet. This is what add-to-calendar-button does on iOS.
 */
export function icsDataUrl(text: string): string {
  return `data:text/calendar;charset=utf-8,${encodeURIComponent(text)}`
}
