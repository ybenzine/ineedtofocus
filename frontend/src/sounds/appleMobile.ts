// Who gets the "silent mode" hint (#307). Only iOS and iPadOS mute web audio with a hardware
// switch, and no web API can read it, so the hint is static text for these devices. Every browser
// on iOS/iPadOS runs on WebKit, so Chrome (CriOS) and Firefox (FxiOS) count too.

/** iPhone, iPad and iPod by user agent; iPadOS reports a Mac, but a Mac has no touch screen. */
export function isAppleMobile(userAgent: string, maxTouchPoints: number): boolean {
  if (/iPhone|iPad|iPod/.test(userAgent)) return true
  return userAgent.includes('Macintosh') && maxTouchPoints > 1
}

/** The running device. Components use this, never navigator directly. */
export function onAppleMobile(): boolean {
  // `?? ''` guards a test that replaces navigator with a bare object; real browsers have both.
  return isAppleMobile(navigator.userAgent ?? '', navigator.maxTouchPoints ?? 0)
}

export const SETTINGS_SILENT_HINT =
  'On iPhone and iPad, the chime, bell and rain are off while silent mode is on.'
export const SETUP_SILENT_HINT =
  'On iPhone and iPad, rain and alerts are off while silent mode is on.'
