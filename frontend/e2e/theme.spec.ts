import { expect, test, type Page } from '@playwright/test'
import {
  expectNoSidewaysScroll,
  finishCountdown,
  installClock,
  newEmail,
  openScreen,
  signIn,
  signUp,
  startCountdown,
} from './helpers'

// The app's themes: dark "Dusk 5°" (#213) and the light set that mirrors it (#214). Every screen
// on the same `--bg` page, no sideways scroll, the nav on one row from 768 px, the timer dark in
// every mode. Set SCREENSHOT_DIR to also save a full-page screenshot of each screen.

interface Palette {
  bg: string
  surface: string
  accent: string
  onAccent: string
  controlBorder: string
  scheme: 'dark' | 'light'
}

const DARK: Palette = {
  bg: 'rgb(17, 17, 42)', // #11112a
  surface: 'rgb(27, 27, 60)', // #1b1b3c
  accent: 'rgb(148, 154, 255)', // #949aff
  onAccent: 'rgb(13, 13, 51)', // #0d0d33
  controlBorder: 'rgb(97, 97, 179)', // #6161b3
  scheme: 'dark',
}

const LIGHT: Palette = {
  bg: 'rgb(238, 238, 250)', // #eeeefa
  surface: 'rgb(251, 251, 255)', // #fbfbff
  accent: 'rgb(65, 70, 209)', // #4146d1
  onAccent: 'rgb(250, 250, 255)', // #fafaff
  controlBorder: 'rgb(108, 108, 174)', // #6c6cae
  scheme: 'light',
}

async function check(page: Page, name: string, palette: Palette): Promise<void> {
  await expectNoSidewaysScroll(page)
  const backgrounds = await page.evaluate(() => ({
    html: getComputedStyle(document.documentElement).backgroundColor,
    body: getComputedStyle(document.body).backgroundColor,
    scheme: getComputedStyle(document.documentElement).colorScheme,
  }))
  expect(backgrounds).toEqual({ html: palette.bg, body: palette.bg, scheme: palette.scheme })
  const dir = process.env.SCREENSHOT_DIR
  if (dir) {
    const width = page.viewportSize()?.width ?? 0
    await page.screenshot({ path: `${dir}/${name}-${palette.scheme}-${width}.png`, fullPage: true })
  }
}

/** The current item stays accent on a surface pill, even hovered or focused (touch keeps hover after a tap). */
async function expectCurrentNavIsAccent(page: Page, palette: Palette): Promise<void> {
  const current = page.getByRole('navigation', { name: 'Screens' }).locator('[aria-current]')
  await expect(current).toHaveCSS('color', palette.accent)
  await expect(current).toHaveCSS('background-color', palette.surface)
}

async function expectNavOnOneRow(page: Page): Promise<void> {
  const tops = await page
    .getByRole('navigation', { name: 'Screens' })
    .getByRole('button')
    .evaluateAll((buttons) => buttons.map((b) => Math.round(b.getBoundingClientRect().top)))
  expect(tops).toHaveLength(4)
  expect(new Set(tops).size).toBe(1)
}

const RUNS: [Palette, number][] = [
  [DARK, 360],
  [DARK, 768],
  [DARK, 1280],
  [LIGHT, 360],
  [LIGHT, 1280],
]

for (const [palette, width] of RUNS) {
  test.describe(`${palette.scheme} device at ${width} px`, () => {
    test.use({
      viewport: { width, height: width === 360 ? 740 : 900 },
      colorScheme: palette.scheme,
    })

    test('every screen follows the device, fits the window and keeps the nav tidy; the timer stays dark', async ({
      page,
    }) => {
      await installClock(page)
      await page.goto('/login')
      await expect(page.getByRole('heading', { name: 'Sign in' })).toBeVisible()
      await check(page, 'auth', palette)

      await signUp(page, newEmail())
      await page.getByRole('radio', { name: 'Pomodoro' }).check()
      await check(page, 'setup', palette)
      if (width >= 768) await expectNavOnOneRow(page)

      await startCountdown(page, { minutes: 1, tag: 'study', goal: 'Read chapter 4' })
      await check(page, 'timer', DARK) // AC9.1: dark in every mode

      await page.clock.fastForward(62_000)
      await expect(page.getByRole('heading', { name: 'Session complete' })).toBeVisible()
      await check(page, 'summary', DARK)

      await page.getByRole('button', { name: 'New session' }).click()
      await finishCountdown(page, { minutes: 1, tag: 'work', goal: 'Draft the report' })
      await page.getByRole('link', { name: 'View history' }).click()
      await expect(page.locator('.history-row')).toHaveCount(2)
      // Back from the dark timer, the page is in the device's theme again.
      await check(page, 'history', palette)
      if (width >= 768) await expectNavOnOneRow(page)
      await expectCurrentNavIsAccent(page, palette)

      // Selected history view and tag: accent fill with its text colour; the rest are outlined.
      const day = page.getByRole('group', { name: 'View' }).getByRole('button', { name: 'Day' })
      await expect(day).toHaveCSS('background-color', palette.accent)
      await expect(day).toHaveCSS('color', palette.onAccent)
      const week = page.getByRole('group', { name: 'View' }).getByRole('button', { name: 'Week' })
      await expect(week).toHaveCSS('border-top-color', palette.controlBorder)
      const allTags = page.getByRole('group', { name: 'Tags' }).getByRole('button').first()
      await expect(allTags).toHaveAttribute('aria-pressed', 'true')
      await expect(allTags).toHaveCSS('background-color', palette.accent)

      await page
        .getByRole('button', { name: /^Archive session/ })
        .first()
        .click()
      await expect(page.getByText('Session archived.')).toBeVisible()
      await openScreen(page, 'Archive')
      await expect(page.locator('.history-row')).toHaveCount(1)
      await expectCurrentNavIsAccent(page, palette) // the pointer is still on the item just clicked
      await check(page, 'archive', palette)
      if (width >= 768) await expectNavOnOneRow(page)

      await openScreen(page, 'Settings')
      await expect(page.getByRole('heading', { name: 'Settings' })).toBeVisible()
      await expectCurrentNavIsAccent(page, palette)
      await check(page, 'settings', palette)
      if (width >= 768) await expectNavOnOneRow(page)
    })
  })
}

test.describe('the Appearance setting', () => {
  test.use({ colorScheme: 'light' })

  test('System follows the device live; Dark and Light override it, survive a reload and sync', async ({
    page,
    browser,
  }) => {
    const email = newEmail()
    await signUp(page, email)
    const html = page.locator('html')
    const bg = () => page.evaluate(() => getComputedStyle(document.body).backgroundColor)

    // Default is System: the device's light setting applies, and it follows a live change.
    await openScreen(page, 'Settings')
    await expect(page.getByRole('radio', { name: 'System (default)' })).toBeChecked()
    await expect(html).not.toHaveAttribute('data-theme', /.*/)
    expect(await bg()).toBe(LIGHT.bg)
    await page.emulateMedia({ colorScheme: 'dark' })
    expect(await bg()).toBe(DARK.bg)
    await page.emulateMedia({ colorScheme: 'light' })

    // Dark beats a light device; the cached choice is applied before first paint after a reload.
    await page.getByRole('radio', { name: 'Dark' }).check()
    await expect(html).toHaveAttribute('data-theme', 'dark')
    expect(await bg()).toBe(DARK.bg)
    await expect(page.locator('meta[name="theme-color"]').first()).toHaveAttribute(
      'content',
      '#11112a',
    )
    // Record when data-theme is first set on a reload: it must happen while the <head> is still
    // being parsed (#root not in the page yet), i.e. by theme-init.js, not by React afterwards.
    await page.addInitScript(() => {
      const w = window as unknown as {
        __firstTheme?: { theme: string | null; rootExists: boolean }
      }
      new MutationObserver(() => {
        const theme = document.documentElement.getAttribute('data-theme')
        if (theme && !w.__firstTheme) {
          w.__firstTheme = { theme, rootExists: !!document.getElementById('root') }
        }
      }).observe(document, {
        attributes: true,
        subtree: true,
        attributeFilter: ['data-theme'],
      })
    })
    await page.reload()
    const first = await page.evaluate(
      () => (window as unknown as { __firstTheme?: unknown }).__firstTheme,
    )
    expect(first).toEqual({ theme: 'dark', rootExists: false })
    expect(await html.getAttribute('data-theme')).toBe('dark')
    expect(await bg()).toBe(DARK.bg)

    // Light beats a dark device.
    await page.emulateMedia({ colorScheme: 'dark' })
    await openScreen(page, 'Settings')
    await page.getByRole('radio', { name: 'Light' }).check()
    expect(await bg()).toBe(LIGHT.bg)
    // The save has reached the server before we look at it from a fresh device.
    await expect
      .poll(async () => (await page.request.get('/api/settings')).json().then((s) => s.theme))
      .toBe('light')

    // A new device (empty storage) gets the saved choice once it has signed in and synced.
    const fresh = await browser.newContext({ colorScheme: 'dark' })
    const other = await fresh.newPage()
    await signIn(other, email)
    await expect(other.locator('html')).toHaveAttribute('data-theme', 'light')
    expect(await other.evaluate(() => getComputedStyle(document.body).backgroundColor)).toBe(
      LIGHT.bg,
    )
    await fresh.close()
  })
})

test.describe('signing out', () => {
  test.use({ colorScheme: 'dark' })

  test('the sign-in screen follows the device, not the last user choice, even after a reload', async ({
    page,
  }) => {
    await signUp(page, newEmail())
    await openScreen(page, 'Settings')
    await page.getByRole('radio', { name: 'Light' }).check()
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'light')
    await page.getByRole('button', { name: 'Sign out' }).click()
    await expect(page.getByRole('heading', { name: 'Sign in' })).toBeVisible()
    await expect(page.locator('html')).not.toHaveAttribute('data-theme', /.*/)
    expect(await page.evaluate(() => getComputedStyle(document.body).backgroundColor)).toBe(DARK.bg)
    await page.reload()
    await expect(page.locator('html')).not.toHaveAttribute('data-theme', /.*/)
  })
})

test.describe('a light device', () => {
  test.use({ colorScheme: 'light' })

  test('selected options use the light accent fill; the others are outlined', async ({ page }) => {
    await signUp(page, newEmail())
    const selected = page.locator('.choice:has(input:checked)').first()
    await expect(selected).toHaveCSS('background-color', LIGHT.accent)
    await expect(selected).toHaveCSS('color', LIGHT.onAccent)
    const other = page.locator('.choice:has(input:not(:checked))').first()
    await expect(other).toHaveCSS('border-top-color', LIGHT.controlBorder)
  })
})

test.describe('a dark device', () => {
  test.use({ colorScheme: 'dark' })

  test('a selected option is an accent fill with dark text; the others are outlined', async ({
    page,
  }) => {
    await signUp(page, newEmail())
    const selected = page.locator('.choice:has(input:checked)').first()
    await expect(selected).toHaveCSS('background-color', DARK.accent)
    await expect(selected).toHaveCSS('color', DARK.onAccent)
    const other = page.locator('.choice:has(input:not(:checked))').first()
    await expect(other).toHaveCSS('border-top-color', DARK.controlBorder)
  })

  test('checkboxes and slider tracks come from the tokens, not the browser', async ({ page }) => {
    await signUp(page, newEmail())
    await openScreen(page, 'Settings')
    const box = page.getByRole('checkbox', { name: /Keep screen awake/ })
    await expect(box).toHaveCSS('appearance', 'none')
    await expect(box).toHaveCSS('border-top-color', DARK.controlBorder)
    await expect(page.getByRole('slider').first()).toHaveCSS('appearance', 'none')
  })

  test('the slider track is filled up to the thumb in Chromium and WebKit', async ({ page }) => {
    await signUp(page, newEmail())
    await openScreen(page, 'Settings')
    const slider = page.getByRole('slider').first()
    await slider.scrollIntoViewIfNeeded()
    const box = await slider.boundingBox()
    if (!box) throw new Error('slider has no box')
    // A 2x2 patch of the track at a fraction of the slider's width, as PNG bytes.
    const patch = (fraction: number) =>
      page.screenshot({
        clip: {
          x: box.x + box.width * fraction,
          y: box.y + box.height / 2 - 1,
          width: 2,
          height: 2,
        },
      })
    const setTo = async (value: string) => {
      await slider.fill(value)
      await slider.evaluate((el) => (el as HTMLInputElement).blur())
    }
    await setTo('0')
    const unfilled20 = await patch(0.2)
    const unfilled80 = await patch(0.8)
    await setTo('50')
    const at50Left = await patch(0.2)
    const at50Right = await patch(0.8)
    expect(at50Left.equals(unfilled20)).toBe(false) // left of the thumb is now filled
    expect(at50Right.equals(unfilled80)).toBe(true) // right of it is still the bare track
  })
})

test('in forced-colors mode the sliders are native and visible, the current nav item is a filled highlight', async ({
  page,
}) => {
  await signUp(page, newEmail())
  await openScreen(page, 'Settings')
  await page.emulateMedia({ forcedColors: 'active' })
  const slider = page.getByRole('slider').first()
  await expect(slider).toHaveCSS('appearance', 'auto')
  const native = await slider.screenshot()
  // The same slider drawn from backgrounds only (the theme's styling) loses its track and thumb.
  await slider.evaluate((el) => ((el as HTMLElement).style.appearance = 'none'))
  const flattened = await slider.screenshot()
  expect(native.equals(flattened)).toBe(false)

  // Take focus and the pointer off the nav, so the check reads the resting style, not :focus or
  // :hover; and compare with an item that is not current.
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur())
  await page.mouse.move(0, 0)
  const nav = page.getByRole('navigation', { name: 'Screens' })
  const style = (item: ReturnType<typeof nav.locator>) =>
    item.evaluate((el) => {
      const css = getComputedStyle(el)
      return { background: css.backgroundColor, color: css.color, border: css.borderTopColor }
    })
  const current = await style(nav.locator('[aria-current]'))
  const other = await style(nav.locator('button:not([aria-current])').first())
  expect(current.background).not.toBe(other.background)
  expect(current.color).not.toBe(other.color)
  expect(current.background).not.toBe('rgba(0, 0, 0, 0)')
  const canvas = await page.evaluate(() => getComputedStyle(document.body).backgroundColor)
  expect(current.background).not.toBe(canvas)
})
