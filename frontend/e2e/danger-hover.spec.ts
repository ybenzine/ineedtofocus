import { expect, test, type Locator } from '@playwright/test'
import { finishCountdown, installClockAndSignUp, openScreen, startCountdown } from './helpers'

// Danger buttons keep the --error colour and border while hovered, in the dark and the light
// theme (#271, guarding #238). jsdom can't evaluate :hover, so this reads computed styles.

/** What `var(--error)` resolves to where the button sits (the timer screen has its own tokens). */
async function errorToken(button: Locator): Promise<string> {
  return button.evaluate((el) => {
    const probe = document.createElement('span')
    probe.style.color = 'var(--error)'
    el.parentElement?.appendChild(probe)
    const resolved = getComputedStyle(probe).color
    probe.remove()
    return resolved
  })
}

async function expectKeepsErrorOnHover(button: Locator, accent: string): Promise<void> {
  const error = await errorToken(button)
  expect(error).not.toBe(accent)
  await button.hover()
  await expect(button).toHaveCSS('color', error)
  await expect(button).toHaveCSS('border-top-color', error)
  await expect(button).toHaveCSS('border-right-color', error)
  await expect(button).toHaveCSS('border-bottom-color', error)
  await expect(button).toHaveCSS('border-left-color', error)
}

const ACCENT = { dark: 'rgb(148, 154, 255)', light: 'rgb(65, 70, 209)' }

test.describe('danger buttons on hover', () => {
  test("dark: the timer's Stop button stays --error, not the accent", async ({ page }) => {
    await installClockAndSignUp(page)
    await startCountdown(page, { minutes: 1 })
    await expectKeepsErrorOnHover(page.getByRole('button', { name: 'Stop' }), ACCENT.dark)
  })

  test('light: "Delete all archived sessions" stays --error, not the accent', async ({ page }) => {
    await installClockAndSignUp(page)
    await openScreen(page, 'Settings')
    await page.getByRole('radio', { name: 'Light' }).check()
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'light')

    await openScreen(page, 'New session')
    await finishCountdown(page, { minutes: 1 })
    await page.getByRole('link', { name: 'View history' }).click()
    await page
      .getByRole('button', { name: /^Archive session/ })
      .first()
      .click()
    await expect(page.getByText('Session archived.')).toBeVisible()
    await openScreen(page, 'Archive')
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'light')

    await expectKeepsErrorOnHover(
      page.getByRole('button', { name: 'Delete all archived sessions' }),
      ACCENT.light,
    )
  })
})
