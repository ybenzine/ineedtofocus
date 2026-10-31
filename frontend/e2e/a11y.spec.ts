import AxeBuilder from '@axe-core/playwright'
import { expect, test, type Page } from '@playwright/test'
import {
  expectNoSidewaysScroll,
  finishCountdown,
  installClock,
  newEmail,
  openHistoryFromSummary,
  openScreen,
  seedRecentYoutubeLink,
  signUp,
  startCountdown,
} from './helpers'

// Accessibility and responsive pass (#24): an automated axe audit of every screen and state in
// the dark and the light theme, the 44 px touch-target rule at 360 px, no sideways scroll at 360,
// 768 and 1280 px, keyboard operation (tab order, Enter/Space, visible focus, the inline
// dialogs), and reduced motion.

const TAP = 44

/** A saved title longer than the 20 characters a recent link shows (#326, #325). */
const LONG_TITLE = 'Lofi hip hop radio - beats to relax and study to'
const RECENT_URL = 'https://youtu.be/dQw4w9WgXcQ'

/** axe, at WCAG 2.2 AA plus best practice: fails on any serious or critical violation. */
async function expectNoSeriousViolations(page: Page): Promise<void> {
  const results = await new AxeBuilder({ page })
    .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa', 'best-practice'])
    .analyze()
  const serious = results.violations.filter(
    (v) => v.impact === 'serious' || v.impact === 'critical',
  )
  expect(
    serious.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(' ')).join(', ')}`),
  ).toEqual([])
}

/**
 * Visible controls whose tap area is under 44 x 44 CSS px. The area counts the control's
 * padding and its clickable label (a checkbox inside a label is as big as the label).
 */
async function smallTargets(page: Page, ignore: string[] = []): Promise<string[]> {
  const found = await page.evaluate((min) => {
    const out: string[] = []
    const selector =
      'button, a[href], input, select, textarea, summary, [role="button"], [tabindex]:not([tabindex="-1"])'
    for (const el of Array.from(document.querySelectorAll<HTMLElement>(selector))) {
      const style = getComputedStyle(el)
      if (style.visibility === 'hidden' || style.display === 'none') continue
      const box = el.getBoundingClientRect()
      if (box.width === 0 && box.height === 0) continue
      let width = box.width
      let height = box.height
      const input = el as HTMLInputElement
      const label =
        el.closest('label') ??
        (el.id ? document.querySelector<HTMLElement>(`label[for="${el.id}"]`) : null) ??
        input.labels?.[0] ??
        null
      if (label) {
        const lb = label.getBoundingClientRect()
        width = Math.max(width, lb.width)
        height = Math.max(height, lb.height)
      }
      if (width < min - 0.5 || height < min - 0.5) {
        const name = (el.getAttribute('aria-label') || el.textContent || input.type || el.tagName)
          .trim()
          .slice(0, 30)
        out.push(`${el.tagName.toLowerCase()} "${name}" ${Math.round(width)}x${Math.round(height)}`)
      }
    }
    return out
  }, TAP)
  return found.filter((entry) => !ignore.some((name) => entry.includes(`"${name}"`)))
}

/** Opens History's Discard dialog: an edit the server refused leaves a "Discard change" button. */
async function openDiscardDialog(page: Page): Promise<void> {
  await finishCountdown(page, { minutes: 1, tag: 'study', goal: 'Read chapter one' })
  await openHistoryFromSummary(page)
  await expect(page.locator('.history-row')).toHaveCount(1)
  // The session must have reached the server, or the edit would ride along with its upload.
  await expect(page.getByText('Not synced yet')).toHaveCount(0)
  await page.route('**/api/sessions/*', (route) =>
    route.request().method() === 'PATCH'
      ? route.fulfill({ status: 422, json: { detail: 'Refused for the test' } })
      : route.fallback(),
  )
  await page.getByRole('button', { name: /^Edit session/ }).click()
  await page.getByLabel('Goal').fill('Changed goal')
  await page.getByRole('button', { name: 'Save' }).click()
  await expect(page.getByText('Couldn’t sync')).toBeVisible()
  await page.getByRole('button', { name: /^Discard change to session/ }).click()
  await expect(page.getByRole('alertdialog')).toBeVisible()
}

const SCHEMES = ['dark', 'light'] as const

for (const scheme of SCHEMES) {
  test.describe(`axe audit of every screen, ${scheme} theme`, () => {
    test.use({ colorScheme: scheme })

    /** The theme under test is really the one showing, so a pass is not for the wrong palette. */
    async function expectTheme(page: Page): Promise<void> {
      await expect
        .poll(() => page.evaluate(() => getComputedStyle(document.documentElement).colorScheme))
        .toBe(scheme)
    }

    test('auth, setup, timer states, summary, History, Archive, Settings', async ({ page }) => {
      await installClock(page)
      // Sign-in and sign-up.
      await page.goto('/login')
      await expect(page.getByRole('button', { name: 'Sign in', exact: true })).toBeVisible()
      await expectTheme(page)
      await expectNoSeriousViolations(page)
      await page.getByRole('button', { name: 'Create an account' }).click()
      await page.getByRole('button', { name: 'Create account' }).click() // empty: field errors
      await expect(page.getByRole('alert').first()).toBeVisible()
      await expectNoSeriousViolations(page)
      await signUp(page, newEmail())
      await seedRecentYoutubeLink(page, RECENT_URL, LONG_TITLE)

      // Setup, with each mode and each audio source open.
      await expectTheme(page)
      await expectNoSeriousViolations(page)
      await page.getByRole('radio', { name: 'Pomodoro' }).check()
      await expectNoSeriousViolations(page)
      await page.getByRole('radio', { name: 'Unlimited' }).check()
      await expectNoSeriousViolations(page)
      await page.getByRole('radio', { name: 'Countdown' }).check()
      for (const source of ['Rain', 'YouTube']) {
        await page.getByRole('radio', { name: source }).check()
        if (source === 'YouTube') {
          // The recent link carries a trimmed title; its full text is the accessible name.
          await expect(page.getByRole('button', { name: LONG_TITLE })).toBeVisible()
        }
        await expectNoSeriousViolations(page)
      }
      await page.getByRole('radio', { name: 'None' }).check()

      // Timer running, paused, in a break (always dark), then the summary.
      await page.getByRole('radio', { name: 'Pomodoro' }).check()
      await page.getByLabel('Focus', { exact: true }).fill('5')
      await page.getByLabel('Short break').fill('1')
      await page.getByLabel('Focus blocks').fill('2')
      await page.getByRole('button', { name: 'Start' }).click()
      await expect(page.getByRole('timer', { name: 'Time' })).toBeVisible()
      await expectNoSeriousViolations(page)
      await page.getByRole('button', { name: 'Pause' }).click()
      await expect(page.getByRole('button', { name: 'Resume' })).toBeVisible()
      await expectNoSeriousViolations(page)
      await page.getByRole('button', { name: 'Resume' }).click()
      await page.clock.fastForward(5 * 60_000 + 2000)
      await expect(page.getByRole('heading', { name: 'Break', exact: true })).toBeVisible()
      await expectNoSeriousViolations(page)
      await page.getByRole('button', { name: 'Stop' }).click()
      await expect(page.getByRole('heading', { name: /Session/ })).toBeVisible()
      await expectNoSeriousViolations(page)

      // A completed countdown gives History something to show.
      await page.getByRole('button', { name: 'New session' }).click()
      await finishCountdown(page, { minutes: 1, tag: 'study', goal: 'Read chapter one' })
      await expectNoSeriousViolations(page)
      await openHistoryFromSummary(page)
      await expectTheme(page)
      await expect(page.locator('.history-row')).toHaveCount(2)
      const views = page.getByRole('group', { name: 'View' })
      for (const name of ['Day', 'Week', 'Month', 'All time']) {
        await views.getByRole('button', { name }).click()
        await expect(views.getByRole('button', { name })).toHaveAttribute('aria-pressed', 'true')
        await expectNoSeriousViolations(page)
      }
      await views.getByRole('button', { name: 'Custom' }).click()
      await expectNoSeriousViolations(page)
      await views.getByRole('button', { name: 'Day' }).click()
      await page
        .getByRole('button', { name: /^Edit session/ })
        .first()
        .click()
      await expectNoSeriousViolations(page)
      await page.getByRole('button', { name: 'Cancel' }).click()
      await page
        .getByRole('button', { name: /^Archive session/ })
        .first()
        .click()
      await expect(page.getByText('Session archived.')).toBeVisible()
      await expectNoSeriousViolations(page)

      // Archive and its delete-all dialog.
      await openScreen(page, 'Archive')
      await expect(page.locator('.history-row')).toHaveCount(1)
      await expectNoSeriousViolations(page)
      await page.getByRole('button', { name: 'Delete all archived sessions' }).click()
      await expect(page.getByRole('alertdialog')).toBeVisible()
      await expectNoSeriousViolations(page)
      await page.getByRole('button', { name: 'Cancel' }).click()

      await openScreen(page, 'Settings')
      await expect(page.getByRole('heading', { name: 'Settings' })).toBeVisible()
      await expectNoSeriousViolations(page)
    })

    test('the Discard dialog and the sign-out confirmation', async ({ page }) => {
      await installClock(page)
      await signUp(page, newEmail())
      await openDiscardDialog(page)
      await expectNoSeriousViolations(page)
      await page.keyboard.press('Escape')
      await expect(page.getByRole('alertdialog')).toHaveCount(0)

      // A session made offline is unsynced, so signing out asks first.
      await page.context().setOffline(true)
      await openScreen(page, 'New session')
      await finishCountdown(page, { minutes: 1 })
      await expectNoSeriousViolations(page)
      await page.getByRole('button', { name: 'New session' }).click()
      await expectNoSeriousViolations(page)
      await openScreen(page, 'Settings')
      await expectNoSeriousViolations(page)
      await openScreen(page, 'History')
      await expect(page.locator('.history-row').first()).toBeVisible()
      await expectNoSeriousViolations(page)
      await page.getByRole('button', { name: 'Sign out' }).click()
      await expect(page.getByRole('alertdialog', { name: 'Confirm sign out' })).toBeVisible()
      await expectNoSeriousViolations(page)
    })

    test('a setup validation error has readable contrast', async ({ page }) => {
      await installClock(page)
      await signUp(page, newEmail())
      await page.getByLabel('Duration').fill('0')
      await expect(page.getByText('Must be a whole number of minutes')).toBeVisible()
      await expectTheme(page)
      // The page paints its own background. Without one, axe assumes white behind the text in
      // the dark theme and reports a false 2.28:1 (#24), so this guards the cause too.
      const painted = await page.evaluate(() => ({
        html: getComputedStyle(document.documentElement).backgroundColor,
        body: getComputedStyle(document.body).backgroundColor,
      }))
      expect(painted.html).not.toBe('rgba(0, 0, 0, 0)')
      expect(painted.body).not.toBe('rgba(0, 0, 0, 0)')
      await expectNoSeriousViolations(page)
    })
  })
}

/** Signs up and visits the main screens at the current viewport, calling `check` on each. */
async function visitEveryScreen(
  page: Page,
  check: (screen: string) => Promise<void>,
): Promise<void> {
  await installClock(page)
  await page.goto('/login')
  await expect(page.getByRole('button', { name: 'Sign in', exact: true })).toBeVisible()
  await check('sign in')
  await page.getByRole('button', { name: 'Create an account' }).click()
  await page.getByRole('button', { name: 'Create account' }).click() // empty: field errors
  await expect(page.getByRole('alert').first()).toBeVisible()
  await check('sign up with errors')
  await signUp(page, newEmail())
  await seedRecentYoutubeLink(page, RECENT_URL, LONG_TITLE)
  await check('setup')
  await page.getByRole('radio', { name: 'Pomodoro' }).check()
  await check('setup, Pomodoro')
  await page.getByRole('radio', { name: 'YouTube' }).check()
  await expect(page.getByRole('button', { name: LONG_TITLE })).toBeVisible()
  await check('setup, YouTube')
  await page.getByRole('radio', { name: 'None' }).check()
  await page.getByRole('radio', { name: 'Countdown' }).check()
  await startCountdown(page, { minutes: 1, tag: 'work', goal: 'W'.repeat(120) })
  await check('timer')
  await page.getByRole('button', { name: 'Pause' }).click()
  await check('timer, paused')
  await page.getByRole('button', { name: 'Resume' }).click()
  await page.clock.fastForward(62_000)
  await expect(page.getByRole('heading', { name: 'Session complete' })).toBeVisible()
  await check('summary')
  await openHistoryFromSummary(page)
  await expect(page.locator('.history-row')).toHaveCount(1)
  const views = page.getByRole('group', { name: 'View' })
  for (const name of ['Day', 'Week', 'Month', 'All time', 'Custom']) {
    await views.getByRole('button', { name }).click()
    await check(`History, ${name}`)
  }
  await views.getByRole('button', { name: 'Day' }).click()
  await page
    .getByRole('button', { name: /^Edit session/ })
    .first()
    .click()
  await check('History, edit form')
  await page.getByRole('button', { name: 'Cancel' }).click()
  await page
    .getByRole('button', { name: /^Archive session/ })
    .first()
    .click()
  await expect(page.getByText('Session archived.')).toBeVisible()
  await check('History, archived notice')
  await openScreen(page, 'Archive')
  await expect(page.locator('.history-row')).toHaveCount(1)
  await check('Archive')
  await page.getByRole('button', { name: 'Delete all archived sessions' }).click()
  await expect(page.getByRole('alertdialog')).toBeVisible()
  await check('Archive, delete-all dialog')
  await page.getByRole('button', { name: 'Cancel' }).click()
  await openScreen(page, 'Settings')
  await expect(page.getByRole('heading', { name: 'Settings' })).toBeVisible()
  await check('Settings')
}

test.describe('touch targets at 360 px', () => {
  test.use({ viewport: { width: 360, height: 740 } })

  test('every screen: all controls are at least 44 x 44', async ({ page }) => {
    await visitEveryScreen(page, async (screen) => {
      expect(await smallTargets(page), screen).toEqual([])
    })
  })

  test('the Discard dialog and the sign-out confirmation', async ({ page, context }) => {
    await installClock(page)
    await signUp(page, newEmail())
    await openDiscardDialog(page)
    expect(await smallTargets(page), 'Discard dialog').toEqual([])
    await page.keyboard.press('Escape')
    await context.setOffline(true)
    await openScreen(page, 'New session')
    await finishCountdown(page, { minutes: 1 })
    await page.getByRole('button', { name: 'New session' }).click()
    await page.getByRole('button', { name: 'Sign out' }).click()
    await expect(page.getByRole('alertdialog', { name: 'Confirm sign out' })).toBeVisible()
    expect(await smallTargets(page), 'sign-out confirmation').toEqual([])
  })

  test('Settings: the alert slider is full width with Preview chime and bell on a row below', async ({
    page,
  }) => {
    await installClock(page)
    await signUp(page, newEmail())
    await openScreen(page, 'Settings')
    await expect(page.getByRole('heading', { name: 'Settings' })).toBeVisible()

    const alert = await page.getByLabel('Alert volume').boundingBox()
    const background = await page.getByLabel('Background audio volume').boundingBox()
    const chime = await page.getByRole('button', { name: 'Preview chime' }).boundingBox()
    const bell = await page.getByRole('button', { name: 'Preview bell' }).boundingBox()
    expect(alert?.width).toBeCloseTo(background?.width ?? 0, 0)
    // Both Preview buttons share one row, below the slider.
    expect(chime?.y).toBeGreaterThanOrEqual((alert?.y ?? 0) + (alert?.height ?? 0))
    expect(Math.abs((chime?.y ?? 0) - (bell?.y ?? 1))).toBeLessThan(2)
  })
})

for (const width of [360, 768, 1280]) {
  test.describe(`at ${width} px`, () => {
    test.use({ viewport: { width, height: width === 360 ? 740 : 900 } })

    test('no screen scrolls sideways', async ({ page }) => {
      await visitEveryScreen(page, async (screen) => {
        const { scrollWidth, innerWidth } = await page.evaluate(() => ({
          scrollWidth: document.documentElement.scrollWidth,
          innerWidth: window.innerWidth,
        }))
        expect(scrollWidth, screen).toBeLessThanOrEqual(innerWidth)
      })
    })
  })
}

/** Which control has focus: its label, text or tag name. */
function focused(page: Page): Promise<string> {
  return page.evaluate(() => {
    const el = document.activeElement as HTMLInputElement | null
    return (el?.labels?.[0]?.textContent ?? el?.textContent ?? el?.tagName ?? '').trim()
  })
}

test.describe('keyboard and screen readers', () => {
  test('setup is reachable in order and Enter starts a session', async ({ page }) => {
    await installClock(page)
    await signUp(page, newEmail())
    const order: string[] = []
    // Tab until Start (at most 40 stops), so the test does not depend on how many controls there are.
    for (let i = 0; i < 40 && order.at(-1) !== 'Start'; i++) {
      await page.keyboard.press('Tab')
      order.push(await focused(page))
    }
    const at = (name: string | RegExp) =>
      order.findIndex((entry) => (typeof name === 'string' ? entry === name : name.test(entry)))
    expect(order.slice(0, 5)).toEqual(['Sign out', 'New session', 'History', 'Archive', 'Settings'])
    expect(at('Start')).toBeGreaterThan(-1)
    // Start comes after the duration, the tag and the goal field.
    expect(at('Duration')).toBeGreaterThan(4)
    expect(at('Start')).toBeGreaterThan(at('Duration'))
    expect(at('Start')).toBeGreaterThan(at('Work'))
    expect(at('Start')).toBeGreaterThan(at(/What are you focusing on/))
    expect(at(/What are you focusing on/)).toBeGreaterThan(at('Work'))

    await page.getByLabel('Duration').focus()
    await page.keyboard.press('Enter')
    await expect(page.getByRole('timer', { name: 'Time' })).toBeVisible()
    // Pause and Stop work with the keyboard too.
    await page.getByRole('button', { name: 'Pause' }).focus()
    await page.keyboard.press('Space')
    await expect(page.getByRole('button', { name: 'Resume' })).toBeVisible()
    await page.keyboard.press('Enter')
    await expect(page.getByRole('button', { name: 'Pause' })).toBeVisible()
  })

  test('the screen nav, mode radios and view buttons work with Enter, Space and the arrow keys', async ({
    page,
  }) => {
    await installClock(page)
    await signUp(page, newEmail())
    const nav = page.getByRole('navigation', { name: 'Screens' })
    await nav.getByRole('button', { name: 'History' }).focus()
    await page.keyboard.press('Enter')
    await expect(page.getByRole('heading', { name: 'History' })).toBeVisible()
    await nav.getByRole('button', { name: 'Settings' }).focus()
    await page.keyboard.press('Space')
    await expect(page.getByRole('heading', { name: 'Settings' })).toBeVisible()
    await nav.getByRole('button', { name: 'New session' }).focus()
    await page.keyboard.press('Enter')
    await expect(page.getByRole('button', { name: 'Start' })).toBeVisible()

    // A radio group is one tab stop, moved with the arrow keys; Space selects.
    await page.getByRole('radio', { name: 'Countdown' }).check()
    await page.getByRole('radio', { name: 'Countdown' }).focus()
    await page.keyboard.press('ArrowRight')
    await expect(page.getByRole('radio', { name: 'Pomodoro' })).toBeChecked()

    await openScreen(page, 'History')
    const views = page.getByRole('group', { name: 'View' })
    await views.getByRole('button', { name: 'Week' }).focus()
    await page.keyboard.press('Space')
    await expect(views.getByRole('button', { name: 'Week' })).toHaveAttribute(
      'aria-pressed',
      'true',
    )
  })

  test('every control has an accessible name and errors are announced', async ({ page }) => {
    await installClock(page)
    await page.goto('/login')
    await page.getByRole('button', { name: 'Create an account' }).click()
    await page.getByRole('button', { name: 'Create account' }).click()
    // Field errors are alerts tied to their input.
    await expect(page.getByRole('alert')).toHaveCount(2)
    await expect(page.getByLabel('Email')).toHaveAttribute('aria-invalid', 'true')
    await expect(page.getByLabel('Password')).toHaveAttribute('aria-invalid', 'true')

    await signUp(page, newEmail())
    // A setup error is announced politely and marked on the input.
    await page.getByLabel('Duration').fill('0')
    await expect(page.getByLabel('Duration')).toHaveAttribute('aria-invalid', 'true')
    const hint = page.locator(
      `#${await page.getByLabel('Duration').getAttribute('aria-describedby')}`,
    )
    await expect(hint).toHaveAttribute('aria-live', 'polite')
    await expect(hint).toContainText('Must be a whole number')
    await page.getByLabel('Duration').fill('25')

    // The timer is a labelled timer with a live phase heading; the controls are named buttons.
    await page.getByRole('button', { name: 'Start' }).click()
    await expect(page.getByRole('timer', { name: 'Time' })).toBeVisible()
    await expect(page.getByRole('heading', { name: 'Focus', exact: true })).toHaveAttribute(
      'aria-live',
      'polite',
    )
    for (const button of await page.locator('button').all()) {
      const name = (await button.getAttribute('aria-label')) ?? (await button.innerText())
      expect(name.trim(), 'a button with no name').not.toBe('')
    }
  })

  for (const scheme of SCHEMES) {
    test.describe(`focus ring, ${scheme} theme`, () => {
      test.use({ colorScheme: scheme })

      test('is visible on every tab stop and has 3:1 contrast with the page', async ({ page }) => {
        await installClock(page)
        await signUp(page, newEmail())
        for (const screen of ['New session', 'History', 'Settings'] as const) {
          await openScreen(page, screen)
          await expect(
            page.getByRole('heading', { name: screen === 'New session' ? /./ : screen }).first(),
          ).toBeVisible()
          // Start from the page, not from the nav button the click left focus on.
          await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur())
          for (let i = 0; i < 8; i++) {
            await page.keyboard.press('Tab')
            const ring = await page.evaluate(() => {
              const channel = (c: number) => {
                const s = c / 255
                return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4
              }
              const luminance = (rgb: string) => {
                const [r, g, b] = (rgb.match(/[\d.]+/g) ?? ['0', '0', '0']).map(Number)
                return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b)
              }
              const el = document.activeElement as Element
              const style = getComputedStyle(el)
              const page = luminance(getComputedStyle(document.body).backgroundColor)
              const ringLum = luminance(style.outlineColor)
              const [hi, lo] = ringLum > page ? [ringLum, page] : [page, ringLum]
              return {
                style: style.outlineStyle,
                width: parseFloat(style.outlineWidth),
                ratio: (hi + 0.05) / (lo + 0.05),
              }
            })
            expect(ring.style, `${screen} stop ${i}`).not.toBe('none')
            expect(ring.width, `${screen} stop ${i}`).toBeGreaterThanOrEqual(2)
            expect(ring.ratio, `${screen} stop ${i}`).toBeGreaterThanOrEqual(3)
          }
        }
      })
    })
  }

  test('focus moves to the new screen after Start and when the summary opens', async ({ page }) => {
    await installClock(page)
    await signUp(page, newEmail())
    await page.getByLabel('Duration').fill('1')
    await page.getByLabel('Duration').focus()
    await page.keyboard.press('Enter')
    await expect(page.getByRole('timer', { name: 'Time' })).toBeVisible()
    expect(await page.evaluate(() => document.activeElement?.tagName)).not.toBe('BODY')
    await page.clock.fastForward(62_000)
    await expect(page.getByRole('heading', { name: 'Session complete' })).toBeVisible()
    expect(await page.evaluate(() => document.activeElement?.tagName)).not.toBe('BODY')
  })

  // The three confirmations are inline alert dialogs, not modals: focus moves to Cancel when one
  // opens, Escape or Cancel closes it and puts focus back on the button that opened it, and Tab
  // is not trapped (the page behind stays reachable, as aria-modal is not set).
  test('the Archive delete-all dialog takes focus, closes with Escape or Cancel and gives focus back', async ({
    page,
  }) => {
    await installClock(page)
    await signUp(page, newEmail())
    await finishCountdown(page, { minutes: 1 })
    await openHistoryFromSummary(page)
    await page
      .getByRole('button', { name: /^Archive session/ })
      .first()
      .click()
    await expect(page.getByText('Session archived.')).toBeVisible()
    await openScreen(page, 'Archive')
    const opener = page.getByRole('button', { name: 'Delete all archived sessions' })
    const dialog = page.getByRole('alertdialog')

    await opener.focus()
    await page.keyboard.press('Enter')
    await expect(dialog).toBeVisible()
    await expect(dialog.getByRole('button', { name: 'Cancel' })).toBeFocused()
    await page.keyboard.press('Tab')
    await expect(dialog.getByRole('button', { name: /^Delete 1 session/ })).toBeFocused()
    await page.keyboard.press('Escape')
    await expect(dialog).toHaveCount(0)
    await expect(opener).toBeFocused()

    await page.keyboard.press('Space')
    await expect(dialog.getByRole('button', { name: 'Cancel' })).toBeFocused()
    await page.keyboard.press('Space')
    await expect(dialog).toHaveCount(0)
    await expect(opener).toBeFocused()
  })

  test('the sign-out confirmation takes focus, closes with Escape or Cancel and gives focus back', async ({
    page,
    context,
  }) => {
    await installClock(page)
    await signUp(page, newEmail())
    await context.setOffline(true)
    await finishCountdown(page, { minutes: 1 })
    await page.getByRole('button', { name: 'New session' }).click()
    const opener = page.getByRole('button', { name: 'Sign out' })
    const dialog = page.getByRole('alertdialog', { name: 'Confirm sign out' })

    await opener.focus()
    await page.keyboard.press('Enter')
    await expect(dialog).toBeVisible()
    await expect(dialog.getByRole('button', { name: 'Cancel' })).toBeFocused()
    await page.keyboard.press('Escape')
    await expect(dialog).toHaveCount(0)
    await expect(opener).toBeFocused()

    await page.keyboard.press('Enter')
    await expect(dialog.getByRole('button', { name: 'Cancel' })).toBeFocused()
    await page.keyboard.press('Space')
    await expect(dialog).toHaveCount(0)
    await expect(opener).toBeFocused()
  })

  test('the Discard dialog takes focus, closes with Escape or Cancel and gives focus back', async ({
    page,
  }) => {
    await installClock(page)
    await signUp(page, newEmail())
    await openDiscardDialog(page)
    const dialog = page.getByRole('alertdialog')
    const opener = page.getByRole('button', { name: /^Discard change to session/ })
    await expect(dialog.getByRole('button', { name: 'Cancel' })).toBeFocused()
    await page.keyboard.press('Escape')
    await expect(dialog).toHaveCount(0)
    await expect(opener).toBeFocused()

    await page.keyboard.press('Enter')
    await expect(dialog.getByRole('button', { name: 'Cancel' })).toBeFocused()
    await page.keyboard.press('Space')
    await expect(dialog).toHaveCount(0)
    await expect(opener).toBeFocused()
  })
})

test.describe('reduced motion', () => {
  test.use({ reducedMotion: 'reduce' })

  test('transitions and animations are switched off on every screen', async ({ page }) => {
    await visitEveryScreen(page, async (screen) => {
      const moving = await page.evaluate(() => {
        // Every value of a comma-separated list counts: "0s, 0.3s" still animates.
        const longest = (list: string) =>
          Math.max(...list.split(',').map((value) => parseFloat(value) || 0))
        return Array.from(document.querySelectorAll('*'))
          .filter((el) => {
            const s = getComputedStyle(el)
            return (
              (s.animationName !== 'none' && longest(s.animationDuration) > 0.001) ||
              longest(s.transitionDuration) > 0.001
            )
          })
          .map((el) => el.tagName.toLowerCase() + '.' + el.className)
      })
      expect(moving, screen).toEqual([])
    })
  })

  test('the time is readable at a glance', async ({ page }) => {
    await installClock(page)
    await signUp(page, newEmail())
    await startCountdown(page, { minutes: 1 })
    const size = await page
      .getByRole('timer', { name: 'Time' })
      .evaluate((el) => parseFloat(getComputedStyle(el).fontSize))
    expect(size).toBeGreaterThanOrEqual(48)
  })
})

// The iPhone/iPad silent-mode hint (#307): visible, readable and inside the screen in both themes.
const IPHONE_UA =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1'

/** WCAG contrast of an element's text against the first opaque background behind it. */
async function textContrast(page: Page, text: string): Promise<number> {
  return page.getByText(text).evaluate((el) => {
    const parse = (value: string) => (value.match(/[\d.]+/g) ?? []).map(Number)
    const channel = (v: number) => {
      const s = v / 255
      return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4
    }
    const luminance = ([r = 0, g = 0, b = 0]: number[]) =>
      0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b)
    let background = [0, 0, 0, 0]
    for (let node: Element | null = el; node; node = node.parentElement) {
      const color = parse(getComputedStyle(node).backgroundColor)
      if (color.length < 4 || (color[3] ?? 1) > 0) {
        background = color
        break
      }
    }
    const a = luminance(parse(getComputedStyle(el).color))
    const b = luminance(background)
    return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05)
  })
}

for (const scheme of SCHEMES) {
  test.describe(`silent-mode hint on an iPhone, ${scheme} theme`, () => {
    test.use({
      colorScheme: scheme,
      userAgent: IPHONE_UA,
      hasTouch: true,
      viewport: { width: 360, height: 740 },
    })

    test('shows in Settings and in Setup with Rain, readable and without sideways scroll', async ({
      page,
    }) => {
      await installClock(page)
      await signUp(page, newEmail())

      await page.getByRole('radio', { name: 'Rain' }).check()
      const setupHint = 'On iPhone and iPad, rain and alerts are off while silent mode is on.'
      await expect(page.getByText(setupHint)).toBeVisible()
      expect(await textContrast(page, setupHint)).toBeGreaterThanOrEqual(4.5)
      await expectNoSidewaysScroll(page)
      await expectNoSeriousViolations(page)
      await page.getByRole('radio', { name: 'None' }).check()
      await expect(page.getByText(setupHint)).toHaveCount(0)

      await openScreen(page, 'Settings')
      const settingsHint =
        'On iPhone and iPad, the chime, bell and rain are off while silent mode is on.'
      await expect(page.getByText(settingsHint)).toBeVisible()
      expect(await textContrast(page, settingsHint)).toBeGreaterThanOrEqual(4.5)
      await expectNoSidewaysScroll(page)
      await expectNoSeriousViolations(page)
      expect(await smallTargets(page)).toEqual([])
    })
  })
}
