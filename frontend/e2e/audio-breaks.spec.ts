import { expect, test } from '@playwright/test'
import { newEmail, openScreen, signIn, signUp } from './helpers'

// AC12.6: "Pause background audio during Pomodoro breaks" is on by default and syncs to the server
// and to a second device like the other settings. The timer behaviour is in Vitest on a fake clock.

test('the pause-audio-on-breaks setting is on by default, saves and syncs', async ({
  page,
  browser,
}) => {
  const email = newEmail()
  await signUp(page, email)
  await openScreen(page, 'Settings')
  const box = page.getByRole('checkbox', { name: 'Pause background audio during Pomodoro breaks' })
  await expect(box).toBeChecked()
  await box.uncheck()
  await expect
    .poll(async () =>
      (await page.request.get('/api/settings'))
        .json()
        .then((s: { pause_audio_on_breaks: boolean }) => s.pause_audio_on_breaks),
    )
    .toBe(false)

  const fresh = await browser.newContext()
  const other = await fresh.newPage()
  await signIn(other, email)
  await openScreen(other, 'Settings')
  await expect(
    other.getByRole('checkbox', { name: 'Pause background audio during Pomodoro breaks' }),
  ).not.toBeChecked()
  await fresh.close()
})
