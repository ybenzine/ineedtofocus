import AxeBuilder from '@axe-core/playwright'
import { expect, test, type Page } from '@playwright/test'
import {
  expectNoSidewaysScroll,
  finishCountdown,
  installClock,
  newEmail,
  openHistoryFromSummary,
  openScreen,
  signUp,
} from './helpers'

// Settings → Calendar, the subscription link and the History download (F14, #382).

async function expectNoSeriousViolations(page: Page): Promise<void> {
  const results = await new AxeBuilder({ page })
    .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa', 'best-practice'])
    .analyze()
  const serious = results.violations.filter(
    (v) => v.impact === 'serious' || v.impact === 'critical',
  )
  expect(serious.map((v) => `${v.id}: ${v.help}`)).toEqual([])
}

test('create a link, fetch it, see the session, reset it and the old link stops working', async ({
  page,
  request,
}) => {
  await installClock(page)
  await signUp(page, newEmail())
  await finishCountdown(page, { minutes: 1, tag: 'study', goal: 'Read chapter one' })
  await page.getByRole('button', { name: 'New session' }).click()

  await openScreen(page, 'Settings')
  const section = page.getByRole('region', { name: 'Calendar' })
  await expect(section.getByRole('button', { name: 'Create link' })).toBeVisible()
  await expectNoSeriousViolations(page)
  await section.getByRole('button', { name: 'Create link' }).click()

  const field = section.getByLabel('Subscription link')
  await expect(field).toBeVisible()
  const first = await field.inputValue()
  expect(first).toMatch(/\/api\/calendar\/[\w-]+\.ics$/)
  await expect(section.getByRole('link', { name: 'Add to Apple Calendar' })).toHaveAttribute(
    'href',
    /^webcal:\/\//,
  )
  await expect(section.getByRole('link', { name: 'Add to Google Calendar' })).toHaveAttribute(
    'href',
    /^https:\/\/calendar\.google\.com\/calendar\/r\?cid=/,
  )
  await expect(section.getByText(/shown only now/)).toBeVisible()
  await expectNoSeriousViolations(page)

  // Nothing of the secret is kept on the device.
  const stored = await page.evaluate(() => JSON.stringify({ ...localStorage, ...sessionStorage }))
  expect(stored).not.toContain(new URL(first).pathname.split('/').pop()?.replace('.ics', '') ?? 'x')

  // A calendar app fetches it (no cookies) and sees the session as an event.
  const feed = await request.get(first)
  expect(feed.status()).toBe(200)
  const text = await feed.text()
  expect(text).toContain('BEGIN:VCALENDAR')
  expect(text).toContain('SUMMARY:Study: Read chapter one')
  expect(text).toContain('CATEGORIES:Study')

  // Later visits say it's subscribed and never show the link again.
  await page.reload()
  await openScreen(page, 'Settings')
  await expect(page.getByText(/Subscribed · last checked by your calendar app/)).toBeVisible()
  await expect(page.getByLabel('Subscription link')).toHaveCount(0)

  // Reset: a new link; the old one is gone.
  await page.getByRole('button', { name: 'Reset link' }).click()
  await page.getByRole('alertdialog').getByRole('button', { name: 'Reset link' }).click()
  const second = await page.getByLabel('Subscription link').inputValue()
  expect(second).not.toBe(first)
  expect((await request.get(first)).status()).toBe(404)
  expect((await request.get(second)).status()).toBe(200)

  // Turn off: the new link stops too.
  await page.getByRole('button', { name: 'Turn off' }).click()
  await page.getByRole('alertdialog').getByRole('button', { name: 'Turn off' }).click()
  await expect(page.getByRole('button', { name: 'Create link' })).toBeVisible()
  expect((await request.get(second)).status()).toBe(404)
})

test('the settings shape the feed, and the History download follows the view', async ({
  page,
  request,
}) => {
  await installClock(page)
  await signUp(page, newEmail())
  await finishCountdown(page, { minutes: 1, tag: 'study', goal: 'Read chapter one' })
  await page.getByRole('button', { name: 'New session' }).click()
  await openScreen(page, 'Settings')
  const section = page.getByRole('region', { name: 'Calendar' })

  await section.getByLabel('Event title').fill('{mode} · {tag}')
  await expect(section.getByText('Countdown · Study')).toBeVisible() // the preview, from the latest session
  await section.getByRole('checkbox', { name: 'Include goals' }).uncheck()
  await section.getByRole('checkbox', { name: 'Nap' }).uncheck()
  await section.getByLabel('Calendar name').fill('Deep work')
  await section.getByLabel('Calendar name').fill('')
  await expect(section.getByText('Give the calendar a name.')).toBeVisible()
  await section.getByLabel('Calendar name').fill('Deep work')
  await section.getByRole('button', { name: 'Create link' }).click()
  const url = await section.getByLabel('Subscription link').inputValue()
  await expect
    .poll(async () => (await (await request.get(url)).text()).includes('SUMMARY:Countdown · Study'))
    .toBe(true)
  const feed = await (await request.get(url)).text()
  expect(feed).toContain('X-WR-CALNAME:Deep work')
  expect(feed).not.toContain('Read chapter one')

  // History: the download is the view on screen.
  await openScreen(page, 'History')
  await expect(page.locator('.history-row')).toHaveCount(1)
  await expectNoSeriousViolations(page)
  const downloading = page.waitForEvent('download')
  await page.getByRole('button', { name: 'Add to calendar (.ics)' }).click()
  const download = await downloading
  expect(download.suggestedFilename()).toMatch(
    /^ineedtofocus-\d{4}-\d{2}-\d{2}-to-\d{4}-\d{2}-\d{2}\.ics$/,
  )
  const { readFileSync } = await import('node:fs')
  const file = readFileSync(await download.path(), 'utf-8')
  expect(file).toContain('BEGIN:VEVENT')
  expect(file).toContain('SUMMARY:Countdown · Study')
})

test.describe('at 360 px', () => {
  test.use({ viewport: { width: 360, height: 640 } })

  test('Settings → Calendar and History have no sideways scroll', async ({ page }) => {
    await installClock(page)
    await signUp(page, newEmail())
    await finishCountdown(page, { minutes: 1, tag: 'work', goal: 'x'.repeat(120) })
    await openHistoryFromSummary(page)
    await expect(page.getByRole('button', { name: 'Add to calendar (.ics)' })).toBeVisible()
    await expectNoSidewaysScroll(page)
    await openScreen(page, 'Settings')
    await page.getByLabel('Event title').fill('{tag}: {goal} · {mode} · {focus_time}'.repeat(3))
    await page.getByRole('button', { name: 'Create link' }).click()
    await expect(page.getByLabel('Subscription link')).toBeVisible()
    await expectNoSidewaysScroll(page)
    await expectNoSeriousViolations(page)
  })
})

test('without an account Settings → Calendar is only the nudge', async ({ page }) => {
  await page.goto('/')
  await page
    .getByRole('navigation', { name: 'Screens' })
    .getByRole('button', { name: 'Settings' })
    .click()
  const section = page.getByRole('region', { name: 'Calendar' })
  await expect(
    section.getByText('Create an account or log in to add your sessions to your calendar.'),
  ).toBeVisible()
  await expect(section.getByRole('link', { name: 'Create an account' })).toBeVisible()
  await expect(section.getByRole('link', { name: 'log in' })).toBeVisible()
  await expect(section.getByRole('button')).toHaveCount(0)
  await expect(section.getByRole('textbox')).toHaveCount(0)
  const stored = await page.evaluate(() => JSON.stringify({ ...localStorage }))
  expect(stored).not.toContain('calendar_')
})
