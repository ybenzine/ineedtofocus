import { afterEach, describe, expect, it } from 'vitest'
import { ANON_ACTIVE_SESSION_KEY, ANON_HELD_ID_KEY } from '../anonymous/keys.ts'
import { startSession } from '../timer/engine.ts'
import { ACTIVE_SESSION_KEY } from '../timer/store.ts'
import { hasStoredSession } from './autoUpdate.ts'

afterEach(() => localStorage.clear())

const stored = JSON.stringify({
  session: startSession(
    { id: 's', config: { mode: 'countdown', minutes: 25 }, tag: 'work', goal: null },
    0,
  ),
  pendingRecord: null,
})

// #244's cross-tab check: "no tab has a stored session" reads both slots (#331).
describe('hasStoredSession', () => {
  it('is false with nothing stored', () => {
    expect(hasStoredSession()).toBe(false)
  })

  it('sees an account session', () => {
    localStorage.setItem(ACTIVE_SESSION_KEY, stored)
    expect(hasStoredSession()).toBe(true)
  })

  it('sees an anonymous session', () => {
    localStorage.setItem(ANON_ACTIVE_SESSION_KEY, stored)
    expect(hasStoredSession()).toBe(true)
  })

  it('does not count the held-session marker: a held session is protected by its own page', () => {
    localStorage.setItem(ANON_HELD_ID_KEY, 's')
    expect(hasStoredSession()).toBe(false)
  })
})
