import { afterEach, describe, expect, it } from 'vitest'
import { captureResetToken, discardResetToken, peekResetToken } from './resetToken.ts'

const TOKEN = 'abcDEF123_-abcDEF123_-abcDEF123_-abcDEF12345'

afterEach(() => {
  discardResetToken()
  window.history.replaceState(null, '', '/')
})

describe('captureResetToken (AC1.9, #350)', () => {
  it('reads the token from the fragment and removes the fragment, keeping path and query', () => {
    window.history.replaceState(null, '', `/reset-password?x=1#token=${TOKEN}`)
    captureResetToken()
    expect(peekResetToken()).toBe(TOKEN)
    expect(window.location.hash).toBe('')
    expect(window.location.pathname + window.location.search).toBe('/reset-password?x=1')
    expect(window.location.href).not.toContain(TOKEN)
  })

  it('keeps the token when called a second time, after the fragment is gone', () => {
    window.history.replaceState(null, '', `/reset-password#token=${TOKEN}`)
    captureResetToken()
    captureResetToken()
    expect(peekResetToken()).toBe(TOKEN)
  })

  it('has no token when the fragment lacks one, and still clears the fragment', () => {
    window.history.replaceState(null, '', '/reset-password#nothing')
    captureResetToken()
    expect(peekResetToken()).toBeNull()
    expect(window.location.hash).toBe('')
  })

  it('leaves every other page alone', () => {
    window.history.replaceState(null, '', `/settings#token=${TOKEN}`)
    captureResetToken()
    expect(peekResetToken()).toBeNull()
    expect(window.location.hash).toBe(`#token=${TOKEN}`)
  })

  it('is forgotten on discard', () => {
    window.history.replaceState(null, '', `/reset-password/#token=${TOKEN}`)
    captureResetToken()
    discardResetToken()
    expect(peekResetToken()).toBeNull()
  })
})
