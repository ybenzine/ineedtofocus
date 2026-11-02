// Hands a generated .ics file to the user (AC14.7). Nothing is uploaded: the file is made in
// memory from the session on the device, so it works offline.

function isIos(): boolean {
  const nav = navigator
  return (
    /iP(hone|ad|od)/.test(nav.userAgent) || (nav.platform === 'MacIntel' && nav.maxTouchPoints > 1)
  )
}

/**
 * Saves `text` as `fileName`. On iOS Safari the file is opened instead, which shows the
 * Calendar "Add event" sheet (only from a click, `open` not false); elsewhere it is a download.
 */
export function saveIcs(text: string, fileName: string, options: { open?: boolean } = {}): void {
  const url = URL.createObjectURL(new Blob([text], { type: 'text/calendar;charset=utf-8' }))
  if (isIos() && options.open !== false) {
    window.open(url, '_blank')
  } else {
    const link = document.createElement('a')
    link.href = url
    link.download = fileName
    link.hidden = true
    document.body.append(link)
    link.click()
    link.remove()
  }
  setTimeout(() => URL.revokeObjectURL(url), 60_000)
}
