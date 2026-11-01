import AxeBuilder from '@axe-core/playwright'
import { expect, test, type Page } from '@playwright/test'
import {
  closeSheet,
  expectNoSidewaysScroll,
  installClock,
  newEmail,
  openHistoryFromSummary,
  openScreen,
  openSheet,
  pickTag,
  signUp,
  startCountdown,
} from './helpers'

// Custom tags (#401, AC7.4-AC7.9) through the real stack.

const tagsSection = (page: Page) => page.getByRole('region', { name: 'Tags' })

async function addTag(page: Page, name: string, color: string): Promise<void> {
  const section = tagsSection(page)
  await section.getByLabel('Tag name').fill(name)
  await section.getByRole('radio', { name: color, exact: true }).check()
  await section.getByRole('button', { name: 'Add tag' }).click()
  await expect(section.getByRole('status')).toContainText(/(Added|Brought back) the tag/)
}

/** The tag's colour dot, as a class name, within a locator. */
async function dotClass(row: ReturnType<Page['locator']>): Promise<string> {
  return (await row.locator('.tag-dot').first().getAttribute('class')) ?? ''
}

test('create a tag, use it, rename it, remove it and bring it back by name', async ({ page }) => {
  await installClock(page)
  await signUp(page, newEmail())

  // Create "Deep work" in Teal.
  await openScreen(page, 'Settings')
  await addTag(page, 'Deep work', 'Teal')
  await expect(page.getByRole('list', { name: 'Your tags' })).toContainText('Deep work')

  // A 1-minute session with it.
  await openScreen(page, 'New session')
  const sheet = await openSheet(page, 'Tag')
  const picker = sheet.getByRole('group', { name: 'Tag' })
  await expect(picker.locator('.tag-dot')).toHaveCount(7)
  await picker.getByRole('radio', { name: 'Deep work' }).check()
  await closeSheet(page)
  await startCountdown(page, { minutes: 1 })
  await expect(page.locator('.timer-meta .tag-dot-teal')).toBeVisible()
  await page.clock.fastForward(62_000)
  await expect(page.getByRole('heading', { name: 'Session complete' })).toBeVisible()
  await expect(page.locator('.summary-details')).toContainText('Deep work')
  await expect(page.locator('.summary-details .tag-dot-teal')).toBeVisible()

  // History shows it with its dot.
  await openHistoryFromSummary(page)
  const row = page.locator('.history-row')
  await expect(row).toHaveCount(1)
  await expect(row).toContainText('Deep work')
  expect(await dotClass(row)).toContain('tag-dot-teal')

  // Rename to "Writing": the session shows the new name.
  await openScreen(page, 'Settings')
  await tagsSection(page).getByRole('button', { name: 'Rename Deep work' }).click()
  await tagsSection(page).getByLabel('New name for Deep work').fill('Writing')
  await tagsSection(page).getByRole('button', { name: 'Save' }).click()
  await expect(tagsSection(page).getByRole('status')).toContainText('Renamed the tag to Writing.')
  await openScreen(page, 'History')
  await expect(row).toContainText('Writing')

  // Remove it: gone from the setup picker, still on the session and in the filter as "(removed)".
  await openScreen(page, 'Settings')
  await tagsSection(page).getByRole('button', { name: 'Remove Writing' }).click()
  await expect(tagsSection(page)).toContainText(
    'Remove Writing? It leaves the tag picker. Sessions that have it keep it.',
  )
  await tagsSection(page).getByRole('button', { name: 'Remove', exact: true }).click()
  await expect(tagsSection(page).getByRole('status')).toContainText('Removed the tag Writing.')
  await openScreen(page, 'New session')
  await expect(page.getByRole('radio', { name: 'Writing' })).toHaveCount(0)
  await openScreen(page, 'History')
  await expect(row).toContainText('Writing')
  const filter = page.getByRole('group', { name: 'Tags' })
  await expect(filter.getByRole('button', { name: 'Writing (removed)' })).toBeVisible()

  // Add "writing" in Red: the removed tag is back with its stored name, in Red, on the session too.
  await openScreen(page, 'Settings')
  await addTag(page, 'writing', 'Red')
  await expect(tagsSection(page).getByRole('list', { name: 'Your tags' })).toContainText('Writing')
  await openScreen(page, 'History')
  await expect(row).toContainText('Writing')
  expect(await dotClass(row)).toContain('tag-dot-red')
  await expect(filter.getByRole('button', { name: 'Writing', exact: true })).toBeVisible()
  await openScreen(page, 'New session')
  await expect(page.getByRole('radio', { name: 'Writing' })).toBeVisible()

  // A reload reads the list back from the account.
  await page.reload()
  await expect(page.getByRole('radio', { name: 'Writing' })).toBeVisible()
})

test('a tag made on one device shows on another after a reload, and offline hides the controls', async ({
  page,
  browser,
}) => {
  await installClock(page)
  const email = newEmail()
  await signUp(page, email)
  await openScreen(page, 'Settings')
  await addTag(page, 'Deep work', 'Teal')

  const other = await browser.newContext()
  const second = await other.newPage()
  await installClock(second)
  await second.goto('/login')
  await second.getByLabel('Email').fill(email)
  await second.getByLabel('Password').fill('correct horse battery')
  await second.getByRole('button', { name: 'Sign in', exact: true }).click()
  await expect(second.getByRole('radio', { name: 'Deep work' })).toBeVisible()
  await other.close()

  // Offline: the list stays, the controls go.
  await page.context().setOffline(true)
  await expect(tagsSection(page).getByText('Changing tags needs a connection.')).toBeVisible()
  await expect(tagsSection(page).getByRole('button')).toHaveCount(0)
  await expect(tagsSection(page)).toContainText('Deep work')
  await page.context().setOffline(false)
  await expect(tagsSection(page).getByLabel('Tag name')).toBeVisible()
})

test('guest mode shows only the built-in tags and no /api/tags call', async ({ page }) => {
  const calls: string[] = []
  page.on('request', (request) => {
    if (request.url().includes('/api/tags')) calls.push(request.url())
  })
  await installClock(page)
  await page.goto('/')
  await expect(page.getByRole('button', { name: 'Start' })).toBeVisible()
  await openSheet(page, 'Tag')
  await expect(page.getByRole('group', { name: 'Tag' }).getByRole('radio')).toHaveCount(6)
  await expect(page.getByRole('link', { name: 'Manage tags' })).toHaveCount(0)
  await closeSheet(page)
  await openScreen(page, 'Settings')
  await expect(tagsSection(page)).toContainText('Create an account or log in to add your own tags.')
  await expect(tagsSection(page).getByRole('link', { name: 'Create an account' })).toHaveAttribute(
    'href',
    '/signup',
  )
  expect(calls).toEqual([])
})

for (const scheme of ['dark', 'light'] as const) {
  test.describe(`a 24-character tag name at 360 x 640, ${scheme} theme`, () => {
    test.use({ viewport: { width: 360, height: 640 }, colorScheme: scheme })

    test('causes no sideways scroll, and axe finds nothing serious', async ({ page }) => {
      const name = 'W'.repeat(24)
      await installClock(page)
      await signUp(page, newEmail())
      await openScreen(page, 'Settings')
      await addTag(page, name, 'Pink')
      await expectNoSidewaysScroll(page)
      const audit = async () => {
        const results = await new AxeBuilder({ page })
          .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa', 'best-practice'])
          .analyze()
        expect(
          results.violations
            .filter((v) => v.impact === 'serious' || v.impact === 'critical')
            .map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(' ')).join(', ')}`),
        ).toEqual([])
      }
      await audit()
      await tagsSection(page)
        .getByRole('button', { name: `Remove ${name}` })
        .click()
      await expectNoSidewaysScroll(page)
      await audit()
      await tagsSection(page).getByRole('button', { name: 'Cancel' }).click()
      await tagsSection(page)
        .getByRole('button', { name: `Rename ${name}` })
        .click()
      await expectNoSidewaysScroll(page)
      await audit()
      await tagsSection(page).getByRole('button', { name: 'Cancel' }).click()

      await openScreen(page, 'New session')
      await pickTag(page, name)
      await expectNoSidewaysScroll(page)
      await audit()
      await startCountdown(page, { minutes: 1 })
      await expectNoSidewaysScroll(page)
      await page.clock.fastForward(62_000)
      await expect(page.getByRole('heading', { name: 'Session complete' })).toBeVisible()
      await expectNoSidewaysScroll(page)

      await openHistoryFromSummary(page)
      await expect(page.locator('.history-row')).toHaveCount(1)
      await expectNoSidewaysScroll(page)
      await audit()
      await page.getByRole('button', { name: /^Edit session/ }).click()
      await expectNoSidewaysScroll(page)
      await page.getByRole('button', { name: 'Cancel' }).click()

      // Archive, with the long name in it.
      await page.getByRole('button', { name: /^Archive session/ }).click()
      await expect(page.getByText('Session archived.')).toBeVisible()
      await openScreen(page, 'Archive')
      await expect(page.locator('.history-row')).toHaveCount(1)
      await expectNoSidewaysScroll(page)
      await audit()
    })
  })
}
