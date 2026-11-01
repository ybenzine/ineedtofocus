import { act, renderHook } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { DEFAULT_PREFERENCES } from './preferences.ts'
import { defaultValues, useSetupModel } from './model.ts'

const before = defaultValues(DEFAULT_PREFERENCES, null)
const saved = defaultValues(
  {
    ...DEFAULT_PREFERENCES,
    pomodoro: { ...DEFAULT_PREFERENCES.pomodoro, focusMinutes: 35 },
  },
  null,
)

describe('useSetupModel', () => {
  it('counts only what differs from the setup it began with', () => {
    const { result } = renderHook(() => useSetupModel(before))
    expect(result.current.changed).toBe(false)
    act(() => result.current.edit({ focus: '40' }))
    expect(result.current.changed).toBe(true)
    act(() => result.current.edit({ focus: before.focus }))
    expect(result.current.changed).toBe(false)
  })

  it('begins the next setup from the defaults it is given, not the ones last rendered', () => {
    const { result, rerender } = renderHook(({ d }) => useSetupModel(d), {
      initialProps: { d: before },
    })
    act(() => result.current.edit({ focus: '35' }))
    // The session saved 35; the new setup is begun before the screen has rendered that.
    act(() => result.current.reset(saved))
    rerender({ d: saved })
    expect(result.current.values.focus).toBe('35')
    expect(result.current.changed).toBe(false)
    // Typing the same 35 again is no change from where it began; 40 is.
    act(() => result.current.edit({ focus: '35' }))
    expect(result.current.changed).toBe(false)
    act(() => result.current.edit({ focus: '40' }))
    expect(result.current.changed).toBe(true)
  })

  it('forgets the failure when a new setup begins', () => {
    const { result } = renderHook(() => useSetupModel(before))
    act(() => result.current.setFailure('nope'))
    act(() => result.current.reset(before))
    expect(result.current.failure).toBeNull()
  })
})
