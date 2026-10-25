import { expect, test, type Page } from '@playwright/test'
import {
  expectNoSidewaysScroll,
  finishCountdown,
  installClock,
  newEmail,
  openScreen,
  signUp,
  startCountdown,
} from './helpers'

// The Dusk 5° theme (#213): every screen on the same `--bg` page, no sideways scroll, the nav on
// one row from 768 px. Set SCREENSHOT_DIR to also save a full-page screenshot of each screen.

const BG = 'rgb(17, 17, 42)' // --bg: #11112a

async function check(page: Page, name: string): Promise<void> {
  await expectNoSidewaysScroll(page)
  const backgrounds = await page.evaluate(() => ({
    html: getComputedStyle(document.documentElement).backgroundColor,
    body: getComputedStyle(document.body).backgroundColor,
    scheme: getComputedStyle(document.documentElement).colorScheme,
  }))
  expect(backgrounds).toEqual({ html: BG, body: BG, scheme: 'dark' })
  const dir = process.env.SCREENSHOT_DIR
  if (dir) {
    const width = page.viewportSize()?.width ?? 0
    await page.screenshot({ path: `${dir}/${name}-${width}.png`, fullPage: true })
  }
}

async function expectNavOnOneRow(page: Page): Promise<void> {
  const tops = await page
    .getByRole('navigation', { name: 'Screens' })
    .getByRole('button')
    .evaluateAll((buttons) => buttons.map((b) => Math.round(b.getBoundingClientRect().top)))
  expect(tops).toHaveLength(4)
  expect(new Set(tops).size).toBe(1)
}

for (const width of [360, 768, 1280]) {
  test.describe(`at ${width} px`, () => {
    test.use({ viewport: { width, height: width === 360 ? 740 : 900 } })

    test('every screen uses the dark page, fits the window and keeps the nav tidy', async ({
      page,
    }) => {
      await installClock(page)
      await page.goto('/')
      await expect(page.getByRole('heading', { name: 'Sign in' })).toBeVisible()
      await check(page, 'auth')

      await signUp(page, newEmail())
      await page.getByRole('radio', { name: 'Pomodoro' }).check()
      await check(page, 'setup')
      if (width >= 768) await expectNavOnOneRow(page)

      await startCountdown(page, { minutes: 1, tag: 'study', goal: 'Read chapter 4' })
      await check(page, 'timer')

      await page.clock.fastForward(62_000)
      await expect(page.getByRole('heading', { name: 'Session complete' })).toBeVisible()
      await check(page, 'summary')

      await page.getByRole('button', { name: 'New session' }).click()
      await finishCountdown(page, { minutes: 1, tag: 'work', goal: 'Draft the report' })
      await page.getByRole('link', { name: 'View history' }).click()
      await expect(page.locator('.history-row')).toHaveCount(2)
      await check(page, 'history')
      if (width >= 768) await expectNavOnOneRow(page)
      // The current screen is accent text on a surface pill.
      const current = page.getByRole('navigation', { name: 'Screens' }).locator('[aria-current]')
      await expect(current).toHaveCSS('color', 'rgb(148, 154, 255)') // --accent
      await expect(current).toHaveCSS('background-color', 'rgb(27, 27, 60)') // --surface

      await page
        .getByRole('button', { name: /^Archive session/ })
        .first()
        .click()
      await expect(page.getByText('Session archived.')).toBeVisible()
      await openScreen(page, 'Archive')
      await expect(page.locator('.history-row')).toHaveCount(1)
      await check(page, 'archive')
      if (width >= 768) await expectNavOnOneRow(page)

      await openScreen(page, 'Settings')
      await expect(page.getByRole('heading', { name: 'Settings' })).toBeVisible()
      await check(page, 'settings')
      if (width >= 768) await expectNavOnOneRow(page)
    })
  })
}

test('a selected option is an accent fill with dark text; the others are outlined', async ({
  page,
}) => {
  await signUp(page, newEmail())
  const selected = page.locator('.choice:has(input:checked)').first()
  await expect(selected).toHaveCSS('background-color', 'rgb(148, 154, 255)') // --accent
  await expect(selected).toHaveCSS('color', 'rgb(13, 13, 51)') // --on-accent
  const other = page.locator('.choice:has(input:not(:checked))').first()
  await expect(other).toHaveCSS('border-top-color', 'rgb(97, 97, 179)') // --control-border
})
