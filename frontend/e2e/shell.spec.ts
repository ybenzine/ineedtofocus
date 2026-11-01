import AxeBuilder from '@axe-core/playwright'
import { expect, test, type Page } from '@playwright/test'
import {
  expectNoSidewaysScroll,
  installClock,
  newEmail,
  openAccountMenu,
  openScreen,
  signUp,
} from './helpers'

// The app shell (#406): header, bottom tab bar on phones, text tabs in the header on wide screens.
// Measured in a real browser, in both themes, signed in with a long email and signed out.

const LONG_PREFIX = 'long.address.'.repeat(5)
const SCREENS = [
  ['New session', '/'],
  ['History', '/history'],
  ['Archive', '/archive'],
  ['Settings', '/settings'],
] as const

async function expectNoSeriousViolations(page: Page): Promise<void> {
  // On a 568 px phone New session scrolls under its pinned Start (#407, AC1), so axe sees the rows
  // behind it as partly covered until they are scrolled into view; the target size is checked on
  // the taller phones.
  const short = (page.viewportSize()?.height ?? Infinity) < 600
  const results = await new AxeBuilder({ page })
    .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa', 'best-practice'])
    .disableRules(short ? ['target-size'] : [])
    .analyze()
  expect(
    results.violations.filter((v) => v.impact === 'serious' || v.impact === 'critical'),
  ).toEqual([])
}

/** The Screens nav's buttons all sit on one row (no wrapping). */
async function expectOneRow(page: Page): Promise<void> {
  const tops = await page
    .getByRole('navigation', { name: 'Screens' })
    .getByRole('button')
    .evaluateAll((els) => els.map((el) => Math.round(el.getBoundingClientRect().top)))
  expect(new Set(tops).size).toBe(1)
}

for (const scheme of ['dark', 'light'] as const) {
  for (const [width, height] of [
    [320, 568],
    [360, 640],
    [375, 667],
    [390, 844],
  ]) {
    test.describe(`phone shell at ${width}x${height}, ${scheme}`, () => {
      test.use({ viewport: { width, height }, colorScheme: scheme })

      test('signed in: tab bar, account menu, no overflow, nothing hidden behind the bar', async ({
        page,
      }) => {
        await installClock(page)
        await signUp(
          page,
          `${LONG_PREFIX}${scheme}${width}${Math.random().toString(36).slice(2, 8)}@example.com`,
        )
        const bar = page.locator('nav.tab-bar')
        await expect(page.getByRole('navigation', { name: 'Screens' })).toBeVisible()
        await expect(bar).toBeVisible()
        await expect(page.locator('header nav')).toHaveCount(0)
        for (const [name, path] of SCREENS) {
          await openScreen(page, name)
          await expect(page).toHaveURL(new RegExp(`${path === '/' ? '/$' : path}$`))
          await expect(bar.getByRole('button', { name })).toHaveAttribute('aria-current', 'page')
          await expectOneRow(page)
          await expectNoSidewaysScroll(page)
          // Every tab is at least 48 px tall, and the bar sits at the bottom edge.
          const boxes = await bar
            .getByRole('button')
            .evaluateAll((els) => els.map((el) => el.getBoundingClientRect().height))
          for (const h of boxes) expect(h).toBeGreaterThanOrEqual(48)
          const barBox = await bar.boundingBox()
          expect(Math.round((barBox?.y ?? 0) + (barBox?.height ?? 0))).toBe(height)
          // The end of the content clears the bar.
          await expect
            .poll(async () => {
              await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight))
              const last = await page.locator('main > :last-child').first().boundingBox()
              return (last?.y ?? 0) + (last?.height ?? 0)
            })
            .toBeLessThanOrEqual(barBox?.y ?? 0)
        }
        // The account button (44 px) opens the menu; the long email wraps inside it.
        await openScreen(page, 'New session')
        const account = page.locator('.account-button')
        const box = await account.boundingBox()
        expect(box?.width).toBeGreaterThanOrEqual(44)
        expect(box?.height).toBeGreaterThanOrEqual(44)
        await openAccountMenu(page)
        await expect(page.getByRole('button', { name: 'Sign out' })).toBeVisible()
        await expectNoSidewaysScroll(page)
        await expectNoSeriousViolations(page)
      })

      test('signed out: Log in in the header and no overflow', async ({ page }) => {
        await installClock(page)
        await page.goto('/')
        await expect(page.getByRole('button', { name: 'Start' })).toBeVisible()
        await expect(page.getByRole('banner').getByRole('link', { name: 'Log in' })).toBeVisible()
        await expect(page.getByRole('link', { name: 'Create account' })).toHaveCount(0)
        await expectOneRow(page)
        await expectNoSidewaysScroll(page)
        await expectNoSeriousViolations(page)
      })
    })
  }

  test.describe(`wide shell, ${scheme}`, () => {
    for (const [width, height, wide] of [
      [767, 800, false],
      [768, 800, true],
      [1280, 800, true],
    ] as const) {
      test.describe(`at ${width}x${height}`, () => {
        test.use({ viewport: { width, height }, colorScheme: scheme })

        test(
          wide ? 'text tabs in the header, no bottom bar' : 'still the bottom bar',
          async ({ page }) => {
            await installClock(page)
            await signUp(page, newEmail())
            await expect(page.getByRole('navigation', { name: 'Screens' })).toBeVisible()
            await expect(page.locator('nav.tab-bar')).toHaveCount(wide ? 0 : 1)
            await expect(page.locator('header nav')).toHaveCount(wide ? 1 : 0)
            await expectOneRow(page)
            await expectNoSidewaysScroll(page)
            if (wide) {
              await expect(
                page.getByRole('banner').getByRole('button', { name: 'New session' }),
              ).toHaveAttribute('aria-current', 'page')
              const main = await page.locator('main').boundingBox()
              expect(Math.abs((main?.x ?? 0) * 2 + (main?.width ?? 0) - width)).toBeLessThanOrEqual(
                1,
              )
            }
            await expectNoSeriousViolations(page)
          },
        )
      })
    }
  })
}
