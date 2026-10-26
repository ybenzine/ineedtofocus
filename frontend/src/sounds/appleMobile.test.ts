import { describe, expect, it } from 'vitest'
import { isAppleMobile } from './appleMobile.ts'

const IPHONE_SAFARI =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1'
const IPHONE_CHROME =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/130.0.0.0 Mobile/15E148 Safari/604.1'
const MAC_SAFARI =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15'
const MAC_CHROME =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36'
const WINDOWS_CHROME =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36'
const ANDROID_CHROME =
  'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Mobile Safari/537.36'

describe('isAppleMobile', () => {
  it.each([
    ['iPhone Safari', IPHONE_SAFARI, 5],
    ['iPhone Chrome (CriOS)', IPHONE_CHROME, 5],
    ['iPadOS (desktop Safari UA)', MAC_SAFARI, 5],
  ])('is true for %s', (_name, ua, touch) => {
    expect(isAppleMobile(ua, touch)).toBe(true)
  })

  it.each([
    ['desktop Chrome on macOS', MAC_CHROME, 0],
    ['desktop Safari on macOS', MAC_SAFARI, 0],
    ['Chrome on Windows', WINDOWS_CHROME, 0],
    ['Chrome on Android', ANDROID_CHROME, 5],
  ])('is false for %s', (_name, ua, touch) => {
    expect(isAppleMobile(ua, touch)).toBe(false)
  })
})
