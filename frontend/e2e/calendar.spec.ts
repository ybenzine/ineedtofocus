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
  await page.getByRole('button', { name: 'Apple Calendar / other (.ics)' }).click()
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
  await page.getByRole('button', { name: 'Apple Calendar / other (.ics)' }).click()
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
  await page.getByRole('button', { name: 'Apple Calendar / other (.ics)' }).click()
  expect((await downloading).suggestedFilename()).toMatch(/\.ics$/)
  await context.setOffline(false)
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
