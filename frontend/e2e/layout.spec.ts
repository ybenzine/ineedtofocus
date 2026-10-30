import AxeBuilder from '@axe-core/playwright'
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

// Layout checks jsdom can't do (#131): measured in a real browser.

const LONG_UNBROKEN = 'W'.repeat(120)
const LONG_WORDS = 'focus on the quarterly planning document and every single appendix '
  .repeat(2)
  .trim()

async function expectCentred(page: Page): Promise<void> {
  const box = await page.locator('main').boundingBox()
  const width = page.viewportSize()?.width ?? 0
  expect(box).not.toBeNull()
  const left = box?.x ?? 0
  const right = width - left - (box?.width ?? 0)
  expect(Math.abs(left - right)).toBeLessThanOrEqual(1)
  expect(left).toBeGreaterThan(0)
}

test.describe('at 360 px', () => {
  test.use({ viewport: { width: 360, height: 740 } })

  test('no screen scrolls sideways, even with very long goals', async ({ page }) => {
    await installClock(page)
    await signUp(page, newEmail())
    await expectNoSidewaysScroll(page) // setup

    // The running timer and the summary, with a goal that has no break opportunity.
    await startCountdown(page, { minutes: 1, tag: 'work', goal: LONG_UNBROKEN })
    await expect(page.locator('.timer-goal')).toBeVisible()
    await expectNoSidewaysScroll(page)
    // Pause and Stop sit above the audio card, not below it (AC9.4).
    const controlsBox = await page.locator('.timer-controls').boundingBox()
    const audioBox = await page.locator('.timer-audio').boundingBox()
    expect(controlsBox).not.toBeNull()
    expect(audioBox).not.toBeNull()
    expect((controlsBox?.y ?? 0) + (controlsBox?.height ?? 0)).toBeLessThanOrEqual(audioBox?.y ?? 0)
    await page.clock.fastForward(62_000)
    await expect(page.getByRole('heading', { name: 'Session complete' })).toBeVisible()
    await expectNoSidewaysScroll(page)

    // A second session with a long goal made of words, so History has both kinds.
    await page.getByRole('button', { name: 'New session' }).click()
    await finishCountdown(page, { minutes: 1, tag: 'study', goal: LONG_WORDS })

    // History, every view.
    await page.goto('/history')
    await expect(page.locator('.history-row')).toHaveCount(2)
    await expectNoSidewaysScroll(page)
    const views = page.getByRole('group', { name: 'View' })
    for (const name of ['Day', 'Week', 'Month', 'All time']) {
      await views.getByRole('button', { name }).click()
      await expect(views.getByRole('button', { name })).toHaveAttribute('aria-pressed', 'true')
      await expect(page.locator('.history-row')).toHaveCount(2)
      await expectNoSidewaysScroll(page)
    }
    await views.getByRole('button', { name: 'Custom' }).click()
    const today = await page.evaluate(() => new Date().toLocaleDateString('en-CA'))
    await page.getByLabel('Start date').fill(today)
    await page.getByLabel('End date').fill(today)
    await page.getByRole('button', { name: 'Show' }).click()
    await expect(page.locator('.history-row')).toHaveCount(2)
    await expectNoSidewaysScroll(page)

    // Archive, with a long goal in it.
    await page
      .getByRole('button', { name: /^Archive session/ })
      .first()
      .click()
    await expect(page.getByText('Session archived.')).toBeVisible()
    await page.goto('/archive')
    await expect(page.locator('.history-row')).toHaveCount(1)
    await expectNoSidewaysScroll(page)

    await page.goto('/settings')
    await expect(page.getByRole('heading', { name: 'Settings' })).toBeVisible()
    await expectNoSidewaysScroll(page)
  })
})

test.describe('at 1280 px', () => {
  test.use({ viewport: { width: 1280, height: 800 } })

  test('the setup and Settings screens are centred', async ({ page }) => {
    await installClock(page)
    await signUp(page, newEmail())
    await expect(page.getByRole('button', { name: 'Start' })).toBeVisible()
    await expectCentred(page)
    await openScreen(page, 'Settings')
    await expect(page.getByRole('heading', { name: 'Settings' })).toBeVisible()
    await expectCentred(page)
  })
})

// An Unlimited session past 10 h reads 10:00:00 to 12:00:00 (#358): the time must stay inside the
// ring's 260 px content box (280 px, 10 px stroke), and shorter times keep 64 px.
for (const width of [320, 390, 1280]) {
  for (const scheme of ['dark', 'light'] as const) {
    test.describe(`an Unlimited timer past 10 h at ${width} px, ${scheme}`, () => {
      test.use({ viewport: { width, height: 800 }, colorScheme: scheme })

      test('the time fits inside the ring', async ({ page }) => {
        await installClock(page)
        await signUp(page, newEmail())
        await page.getByRole('radio', { name: 'Unlimited' }).check()
        await page.getByRole('button', { name: 'Start' }).click()
        const clock = page.getByRole('timer', { name: 'Time' })
        await expect(clock).toBeVisible()
        await expect(clock).toHaveCSS('font-size', '64px')

        for (const [ms, text] of [
          [10 * 3_600_000 + 2000, '10:00:0'],
          [1_000 * (1 * 3600 + 59 * 60 + 30), '11:59:'],
        ] as const) {
          await page.clock.fastForward(ms)
          await expect(clock).toContainText(text)
          const time = await clock.boundingBox()
          const ring = await page.locator('.timer-ring').boundingBox()
          expect(time).not.toBeNull()
          expect(ring).not.toBeNull()
          // The text's own width, not the (wider) block it sits in.
          const textBox = await clock.evaluate((el) => {
            const range = document.createRange()
            range.selectNodeContents(el)
            const r = range.getBoundingClientRect()
            return { left: r.left, right: r.right }
          })
          const inner = 10 + 2 // stroke width; the content box starts here
          expect(textBox.left).toBeGreaterThanOrEqual((ring?.x ?? 0) + inner - 2)
          expect(textBox.right).toBeLessThanOrEqual((ring?.x ?? 0) + (ring?.width ?? 0) - inner + 2)
          expect(textBox.right - textBox.left).toBeLessThanOrEqual(260)
          await expect(clock).toHaveCSS('font-variant-numeric', 'tabular-nums')
          const size = parseFloat(await clock.evaluate((el) => getComputedStyle(el).fontSize))
          expect(size).toBeLessThan(64)
        }
        await expectNoSidewaysScroll(page)
        const results = await new AxeBuilder({ page })
          .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa', 'best-practice'])
          .analyze()
        expect(
          results.violations.filter((v) => v.impact === 'serious' || v.impact === 'critical'),
        ).toEqual([])
      })
    })
  }
}
