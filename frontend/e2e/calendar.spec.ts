import AxeBuilder from '@axe-core/playwright'
import { expect, test, type Page } from '@playwright/test'
import {
  expectNoSidewaysScroll,
  finishCountdown,
  installClock,
  newEmail,
  openHistoryFromSummary,
  signUp,
} from './helpers'

// Add to calendar for one session (F14, AC14.7) through the real stack.

/** Unfolds the file and returns its properties by name (the first VEVENT's), after checks. */
function parseIcs(text: string): Record<string, string> {
  expect(text.endsWith('\r\n')).toBe(true)
  const lines: string[] = []
  for (const line of text.split('\r\n').slice(0, -1)) {
    expect(Buffer.byteLength(line, 'utf-8')).toBeLessThanOrEqual(75)
    if (line.startsWith(' ')) lines[lines.length - 1] += line.slice(1)
    else lines.push(line)
  }
  expect(lines[0]).toBe('BEGIN:VCALENDAR')
  expect(lines.at(-1)).toBe('END:VCALENDAR')
  const begin = lines.indexOf('BEGIN:VEVENT')
  const end = lines.indexOf('END:VEVENT')
  expect(begin).toBeGreaterThan(0)
  expect(end).toBeGreaterThan(begin)
  const props: Record<string, string> = {}
  for (const line of lines.slice(begin + 1, end)) {
    const colon = line.indexOf(':')
    props[line.slice(0, colon)] = line.slice(colon + 1)
  }
  return props
}

async function expectNoSeriousViolations(page: Page): Promise<void> {
  const results = await new AxeBuilder({ page })
    .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa', 'best-practice'])
    .analyze()
  const serious = results.violations.filter(
    (v) => v.impact === 'serious' || v.impact === 'critical',
  )
  expect(serious.map((v) => `${v.id}: ${v.help}`)).toEqual([])
}

test('a finished session offers Google Calendar and a .ics that parses, on the summary and in History', async ({
  page,
}) => {
  await installClock(page)
  await signUp(page, newEmail())
  await finishCountdown(page, { minutes: 1, tag: 'study', goal: 'Read, think; write' })

  // Summary: both choices.
  const control = page.getByRole('button', { name: /^Add to calendar: Study, 1 min on / })
  await control.click()
  const google = page.getByRole('link', { name: 'Google Calendar' })
  await expect(google).toBeVisible()
  await expect(google).toHaveAttribute('target', '_blank')
  const url = new URL((await google.getAttribute('href')) ?? '')
  expect(url.origin + url.pathname).toBe('https://calendar.google.com/calendar/render')
  expect(url.searchParams.get('text')).toBe('Study: Read, think; write')
  expect(url.searchParams.get('dates')).toMatch(/^\d{8}T\d{6}Z\/\d{8}T\d{6}Z$/)
  await expectNoSeriousViolations(page)

  const downloading = page.waitForEvent('download')
  await page.getByRole('link', { name: 'Apple Calendar / other (.ics)' }).click()
  const download = await downloading
  expect(download.suggestedFilename()).toMatch(/^ineedtofocus-\d{4}-\d{2}-\d{2}-\d{4}\.ics$/)
  const path = await download.path()
  const { readFileSync } = await import('node:fs')
  const props = parseIcs(readFileSync(path, 'utf-8'))
  expect(props.UID).toMatch(/^[0-9a-f-]{36}@ineedtofoc\.us$/)
  expect(props.SUMMARY).toBe('Study: Read\\, think\\; write')
  expect(props.CATEGORIES).toBe('Study')
  expect(props.TRANSP).toBe('TRANSPARENT')
  expect(props.DESCRIPTION).toContain('Goal: Read\\, think\\; write\\nTag: Study')
  expect(props.DTSTART).toMatch(/^\d{8}T\d{6}Z$/)

  // The same session in History has the same UID.
  await openHistoryFromSummary(page)
  await page.getByRole('button', { name: /^Add to calendar: Study, 1 min on / }).click()
  await expect(page.getByRole('link', { name: 'Google Calendar' })).toBeVisible()
  await expectNoSeriousViolations(page)
  const again = page.waitForEvent('download')
  await page.getByRole('link', { name: 'Apple Calendar / other (.ics)' }).click()
  const second = parseIcs(readFileSync((await (await again).path()) ?? '', 'utf-8'))
  expect(second.UID).toBe(props.UID)
})

test('offline, Google Calendar is disabled and the .ics still downloads', async ({
  page,
  context,
}) => {
  await installClock(page)
  await signUp(page, newEmail())
  await finishCountdown(page, { minutes: 1, tag: 'work' })
  await context.setOffline(true)
  await page.getByRole('button', { name: /^Add to calendar: Work, 1 min on / }).click()
  const google = page.getByRole('button', { name: 'Google Calendar' })
  await expect(google).toHaveAttribute('aria-disabled', 'true')
  await expect(page.getByText('Needs a connection')).toBeVisible()
  const downloading = page.waitForEvent('download')
  await page.getByRole('link', { name: 'Apple Calendar / other (.ics)' }).click()
  expect((await downloading).suggestedFilename()).toMatch(/\.ics$/)
  await context.setOffline(false)
})

test.describe('by touch (#445)', () => {
  test.use({ hasTouch: true, isMobile: true })

  test('tapping each choice opens Google in a new tab and downloads the .ics', async ({ page }) => {
    await installClock(page)
    await signUp(page, newEmail())
    await finishCountdown(page, { minutes: 1, tag: 'work' })
    await page.getByRole('button', { name: /^Add to calendar: / }).tap()
    // iOS Safari focuses nothing on a tap, so the blur that used to close the menu fired first.
    await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur())
    await page
      .context()
      .route('https://calendar.google.com/**', (route) => route.fulfill({ body: 'ok' }))
    const popup = page.waitForEvent('popup')
    await page.getByRole('link', { name: 'Google Calendar' }).tap()
    expect((await popup).url()).toContain('calendar.google.com')
    await page.getByRole('button', { name: /^Add to calendar: / }).tap()
    await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur())
    const downloading = page.waitForEvent('download')
    await page.getByRole('link', { name: 'Apple Calendar / other (.ics)' }).tap()
    expect((await downloading).suggestedFilename()).toMatch(/\.ics$/)
  })
})

test('with the menu open on the summary, one click on View history opens History and nothing shifts (#429)', async ({
  page,
}) => {
  await installClock(page)
  await signUp(page, newEmail())
  await finishCountdown(page, { minutes: 1, tag: 'work' })
  const link = page.getByRole('link', { name: 'View history' })
  const before = await link.boundingBox()
  await page.getByRole('button', { name: /^Add to calendar: / }).click()
  await expect(page.getByRole('link', { name: 'Google Calendar' })).toBeVisible()
  expect(await link.boundingBox()).toEqual(before)
  await link.click()
  await expect(page.getByRole('heading', { name: 'History' })).toBeVisible()
})

test.describe('at 360 px, menu on a History row', () => {
  test.use({ viewport: { width: 360, height: 640 } })

  test('opens without overflow and a click on another control goes through', async ({ page }) => {
    await installClock(page)
    await signUp(page, newEmail())
    await finishCountdown(page, { minutes: 1, tag: 'work' })
    await openHistoryFromSummary(page)
    const edit = page.getByRole('button', { name: /^Edit session/ }).first()
    const top = () => edit.evaluate((el) => el.getBoundingClientRect().top + window.scrollY)
    const before = await top()
    await page.getByRole('button', { name: /^Add to calendar: / }).click()
    await expect(page.getByRole('link', { name: 'Google Calendar' })).toBeVisible()
    await expectNoSidewaysScroll(page)
    expect(await top()).toBe(before)
    await page.getByRole('heading', { name: 'History' }).click()
    await expect(page.getByRole('link', { name: 'Google Calendar' })).toHaveCount(0)
  })
})

test.describe('at 360 px', () => {
  test.use({ viewport: { width: 360, height: 640 } })

  test('the open control does not overflow, and works by keyboard', async ({ page }) => {
    await installClock(page)
    await signUp(page, newEmail())
    await finishCountdown(page, { minutes: 1, tag: 'meditation', goal: 'x'.repeat(120) })
    const control = page.getByRole('button', { name: /^Add to calendar: / })
    await control.focus()
    await page.keyboard.press('Enter')
    await expect(page.getByRole('link', { name: 'Google Calendar' })).toBeFocused()
    await expectNoSidewaysScroll(page)
    await expectNoSeriousViolations(page)
    await page.keyboard.press('Escape')
    await expect(control).toBeFocused()
    await expect(page.getByRole('link', { name: 'Google Calendar' })).toHaveCount(0)

    await openHistoryFromSummary(page)
    await page.getByRole('button', { name: /^Add to calendar: / }).click()
    await expectNoSidewaysScroll(page)
  })
})

test.describe('on iOS (#454)', () => {
  test.use({
    userAgent:
      'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1',
  })

  test('the .ics choice is a same-tab link to the server copy once synced', async ({ page }) => {
    await installClock(page)
    await signUp(page, newEmail())
    await finishCountdown(page, { minutes: 1, tag: 'work', goal: 'Read' })
    await page.getByRole('button', { name: /^Add to calendar: Work, 1 min on / }).click()

    // Enabled as a link once the session has synced (a disabled button until then).
    const choice = page.getByRole('link', { name: 'Apple Calendar / other (.ics)' })
    await expect(choice).toBeVisible({ timeout: 15_000 })
    await expect(choice).toHaveAttribute('target', '_self')
    await expect(choice).not.toHaveAttribute('download')
    const href = (await choice.getAttribute('href')) ?? ''
    expect(href).toMatch(/^\/api\/calendar\/session\/[0-9a-f-]{36}\.ics\?tz=[^&]+$/)
    await expectNoSeriousViolations(page)

    // Following it returns the session's event as text/calendar.
    const response = await page.context().request.get(href)
    expect(response.status()).toBe(200)
    expect(response.headers()['content-type']).toContain('text/calendar')
    const props = parseIcs(await response.text())
    const id = /session\/([0-9a-f-]{36})\.ics/.exec(href)?.[1]
    expect(props.UID).toBe(`${id}@ineedtofoc.us`)
    expect(props.SUMMARY).toContain('Work')

    // A real click on the link requests the same URL.
    const requested = page.waitForRequest((r) => r.url().endsWith(href))
    await choice.click().catch(() => undefined)
    await requested
  })

  test('offline the choice is disabled with a hint', async ({ page, context }) => {
    await installClock(page)
    await signUp(page, newEmail())
    await finishCountdown(page, { minutes: 1, tag: 'work' })
    await context.setOffline(true)
    await page.getByRole('button', { name: /^Add to calendar: Work, 1 min on / }).click()
    const choice = page.getByRole('button', { name: 'Apple Calendar / other (.ics)' })
    await expect(choice).toHaveAttribute('aria-disabled', 'true')
    await expect(page.getByText('Needs a connection').first()).toBeVisible()
    await context.setOffline(false)
  })
})
