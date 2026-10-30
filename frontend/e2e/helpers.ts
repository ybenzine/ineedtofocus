import { expect, type APIRequestContext, type BrowserContext, type Page } from '@playwright/test'

export const PASSWORD = 'correct horse battery'

let counter = 0

/** A fresh address per call, so tests never share an account. */
export function newEmail(): string {
  counter += 1
  return `e2e-${Date.now()}-${counter}-${Math.random().toString(36).slice(2, 8)}@example.com`
}

/**
 * A fake clock that starts at midday local time, three days ago, and then runs on its own;
 * tests jump ahead with it. A fixed midday keeps midnight and week boundaries from flaking.
 */
export async function installClock(page: Page): Promise<void> {
  const start = new Date()
  start.setDate(start.getDate() - 3)
  start.setHours(12, 0, 0, 0)
  await page.clock.install({ time: start })
}

/** Signs up on a page with the fake clock installed. */
export async function installClockAndSignUp(page: Page, email = newEmail()): Promise<string> {
  await installClock(page)
  await signUp(page, email)
  return email
}

/** From the summary screen to History. */
export async function openHistoryFromSummary(page: Page): Promise<void> {
  await page.getByRole('link', { name: 'View history' }).click()
  await expect(page.getByRole('heading', { name: 'History' })).toBeVisible()
}

export async function newPage(context: BrowserContext): Promise<Page> {
  const page = await context.newPage()
  await installClock(page)
  return page
}

export async function signUp(page: Page, email: string): Promise<void> {
  await page.goto('/')
  await page.getByRole('button', { name: 'Create an account' }).click()
  await page.getByLabel('Email').fill(email)
  await page.getByLabel('Password').fill(PASSWORD)
  await page.getByRole('button', { name: 'Create account' }).click()
  await expect(page.getByRole('button', { name: 'Start' })).toBeVisible()
}

export async function signIn(page: Page, email: string): Promise<void> {
  await page.goto('/')
  await page.getByLabel('Email').fill(email)
  await page.getByLabel('Password').fill(PASSWORD)
  await page.getByRole('button', { name: 'Sign in', exact: true }).click()
  await expect(page.getByRole('button', { name: 'Start' })).toBeVisible()
}

export interface CountdownOptions {
  minutes?: number
  tag?: string
  goal?: string
}

/** Starts a countdown from the setup screen. */
export async function startCountdown(page: Page, options: CountdownOptions = {}): Promise<void> {
  const { minutes = 1, tag, goal } = options
  await page.getByRole('radio', { name: 'Countdown' }).check()
  await page.getByLabel('Duration').fill(String(minutes))
  // The radio labels are capitalised ("Study"); the tag values are not.
  if (tag) await page.getByRole('radio', { name: new RegExp(`^${tag}$`, 'i') }).check()
  if (goal) await page.getByLabel(/What are you focusing on/).fill(goal)
  await page.getByRole('button', { name: 'Start' }).click()
  await expect(page.getByRole('timer', { name: 'Time' })).toBeVisible()
}

/** Starts a countdown, lets its time run out on the fake clock and waits for the summary. */
export async function finishCountdown(page: Page, options: CountdownOptions = {}): Promise<void> {
  const minutes = options.minutes ?? 1
  await startCountdown(page, options)
  await page.clock.fastForward((minutes * 60 + 2) * 1000)
  await expect(page.getByRole('heading', { name: 'Session complete' })).toBeVisible()
}

export async function openScreen(
  page: Page,
  name: 'New session' | 'History' | 'Archive' | 'Settings',
): Promise<void> {
  await page.getByRole('navigation', { name: 'Screens' }).getByRole('button', { name }).click()
}

/** The totals shown at the top of History. */
export async function historyTotals(page: Page): Promise<{ focus: string; sessions: string }> {
  const totals = page.locator('.history-totals')
  await totals.waitFor({ timeout: 2000 })
  const focus = await totals.locator('div', { hasText: 'Focus time' }).locator('dd').textContent()
  const sessions = await totals.locator('div', { hasText: 'Sessions' }).locator('dd').textContent()
  return { focus: (focus ?? '').trim(), sessions: (sessions ?? '').trim() }
}

/** Waits for the totals to settle on the expected values (History reloads after each change). */
export async function expectTotals(
  page: Page,
  expected: { focus: string; sessions: string },
): Promise<void> {
  await expect
    .poll(() => historyTotals(page).catch(() => ({ focus: '(loading)', sessions: '' })))
    .toEqual(expected)
}

/** How many sessions the server holds for the signed-in user (all time). */
export async function serverSessionCount(request: APIRequestContext): Promise<number> {
  const response = await request.get('/api/history?view=all&tz=UTC')
  expect(response.ok()).toBe(true)
  const body = (await response.json()) as { session_count: number }
  return body.session_count
}

/** No horizontal scroll: the page is no wider than the window. */
export async function expectNoSidewaysScroll(page: Page): Promise<void> {
  const { scrollWidth, innerWidth } = await page.evaluate(() => ({
    scrollWidth: document.documentElement.scrollWidth,
    innerWidth: window.innerWidth,
  }))
  expect(scrollWidth).toBeLessThanOrEqual(innerWidth)
}

/**
 * Puts a YouTube link, with a saved title, in the signed-in user's recent links (AC8.6, #326), as
 * the timer screen would after the player reported the title.
 */
export async function seedRecentYoutubeLink(page: Page, url: string, title: string): Promise<void> {
  const response = await page.request.post('/api/youtube-links', { data: { url, title } })
  expect(response.ok()).toBe(true)
}
