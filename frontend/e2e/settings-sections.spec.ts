import AxeBuilder from '@axe-core/playwright'
import { expect, test } from '@playwright/test'
import {
  expectNoSidewaysScroll,
  installClock,
  newEmail,
  openScreen,
  openSection,
  openSheet,
  signUp,
} from './helpers'

// Settings sections (#495, AC12.9, AC12.10, AC7.10) in a real browser.

test.use({ viewport: { width: 360, height: 740 } })

const toggleOf = (page: import('@playwright/test').Page, name: string) =>
  page.getByRole('heading', { level: 2, name, exact: true }).getByRole('button')

test('a section header toggles with Enter and Space and is at least 44 px tall', async ({
  page,
}) => {
  await installClock(page)
  await signUp(page, newEmail())
  await openScreen(page, 'Settings')
  const toggle = toggleOf(page, 'Timer')
  await expect(toggle).toHaveAttribute('aria-expanded', 'true')
  expect((await toggle.boundingBox())?.height ?? 0).toBeGreaterThanOrEqual(44)
  await toggle.focus()
  await page.keyboard.press('Enter')
  await expect(toggle).toHaveAttribute('aria-expanded', 'false')
  await expect(page.getByLabel('Default reminder interval (unlimited timer)')).toBeHidden()
  await page.keyboard.press('Space')
  await expect(toggle).toHaveAttribute('aria-expanded', 'true')
  await expect(page.getByLabel('Default reminder interval (unlimited timer)')).toBeVisible()
})

for (const scheme of ['dark', 'light'] as const) {
  test(`every section open has no sideways scroll and no serious axe violations (${scheme})`, async ({
    page,
  }) => {
    await page.emulateMedia({ colorScheme: scheme })
    await installClock(page)
    await signUp(page, newEmail())
    await openScreen(page, 'Settings')
    for (const name of ['Tags', 'Calendar', 'Account']) await openSection(page, name)
    await expectNoSidewaysScroll(page)
    const { violations } = await new AxeBuilder({ page }).analyze()
    expect(violations.filter((v) => v.impact === 'serious' || v.impact === 'critical')).toEqual([])
  })
}

test('Manage tags opens Settings with Tags open and in view', async ({ page }) => {
  await installClock(page)
  await signUp(page, newEmail())
  const sheet = await openSheet(page, 'Tag')
  await sheet.getByRole('link', { name: 'Manage tags' }).click()
  await expect(page.getByRole('heading', { level: 1, name: 'Settings' })).toBeVisible()
  await expect(toggleOf(page, 'Tags')).toHaveAttribute('aria-expanded', 'true')
  await expect(toggleOf(page, 'Calendar')).toHaveAttribute('aria-expanded', 'false')
  await expect(page.getByLabel('Tag name')).toBeInViewport()
})
