import AxeBuilder from '@axe-core/playwright'
import { expect, test, type Page } from '@playwright/test'
import {
  finishCountdown,
  installClock,
  newEmail,
  openScreen,
  signUp,
  startCountdown,
} from './helpers'

// Accessibility and responsive pass (#24): an automated axe audit of every screen, the 44 px
// touch-target rule at 360 px, keyboard operation, and reduced motion. Tests marked `fixme`
// reproduce open bugs (#147 to #152) and flip to normal tests when those are fixed.

const TAP = 44

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

test.describe('axe audit of every screen', () => {
  test('auth, setup, timer states, summary, History, Archive, Settings', async ({ page }) => {
    await installClock(page)
    // Sign-in and sign-up.
    await page.goto('/')
    await expect(page.getByRole('button', { name: 'Sign in', exact: true })).toBeVisible()
    await expectNoSeriousViolations(page)
    await page.getByRole('button', { name: 'Create an account' }).click()
    await page.getByRole('button', { name: 'Create account' }).click() // empty: field errors
    await expect(page.getByRole('alert').first()).toBeVisible()
    await expectNoSeriousViolations(page)
    await signUp(page, newEmail())

    // Setup, with Pomodoro and each audio source open.
    await expectNoSeriousViolations(page)
    await page.getByRole('radio', { name: 'Pomodoro' }).check()
    await expectNoSeriousViolations(page)
    await page.getByRole('radio', { name: 'Unlimited' }).check()
    await expectNoSeriousViolations(page)
    await page.getByRole('radio', { name: 'Countdown' }).check()
    for (const source of ['Rain', 'YouTube']) {
      await page.getByRole('radio', { name: source }).check()
      await expectNoSeriousViolations(page)
    }
    await page.getByRole('radio', { name: 'None' }).check()

    // Timer running, paused, in a break (the dark screen), then the summary.
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
    await page.getByRole('link', { name: 'View history' }).click()
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

  test('offline: the setup screen, Settings, History and the sign-out confirmation', async ({
    page,
    context,
  }) => {
    await installClock(page)
    await signUp(page, newEmail())
    await context.setOffline(true)
    // A session made offline is unsynced, so signing out asks first.
    await finishCountdown(page, { minutes: 1 })
    await expectNoSeriousViolations(page)
    await page.getByRole('button', { name: 'New session' }).click()
    await expectNoSeriousViolations(page)
    await openScreen(page, 'Settings')
    await expectNoSeriousViolations(page)
    await openScreen(page, 'History')
    await expect(page.locator('.history-row')).toHaveCount(1)
    await expectNoSeriousViolations(page)
    await page.getByRole('button', { name: 'Sign out' }).click()
    await expect(page.getByRole('alertdialog', { name: 'Confirm sign out' })).toBeVisible()
    await expectNoSeriousViolations(page)
  })

  test('a setup validation error has readable contrast', async ({ page }) => {
    test.fixme(true, 'Bug #149: .field-error is #ff8a80 on white, 2.28:1')
    await installClock(page)
    await signUp(page, newEmail())
    await page.getByLabel('Duration').fill('0')
    await expect(page.getByText('Must be a whole number of minutes')).toBeVisible()
    await expectNoSeriousViolations(page)
  })
})

test.describe('touch targets at 360 px', () => {
  test.use({ viewport: { width: 360, height: 740 } })

  test('setup, timer, summary, History, Archive and its dialog are all at least 44 x 44', async ({
    page,
  }) => {
    await installClock(page)
    await signUp(page, newEmail())
    // "Sign out" is covered by the next test (#147).
    const ignore = ['Sign out']
    expect(await smallTargets(page, ignore)).toEqual([])
    await page.getByRole('radio', { name: 'Pomodoro' }).check()
    expect(await smallTargets(page, ignore)).toEqual([])
    await page.getByRole('radio', { name: 'Countdown' }).check()
    await page.getByRole('radio', { name: 'YouTube' }).check()
    expect(await smallTargets(page, ignore)).toEqual([])
    await page.getByRole('radio', { name: 'None' }).check()

    await startCountdown(page, { minutes: 1, tag: 'work' })
    expect(await smallTargets(page, ignore)).toEqual([])
    await page.clock.fastForward(62_000)
    await expect(page.getByRole('heading', { name: 'Session complete' })).toBeVisible()
    expect(await smallTargets(page, ignore)).toEqual([])

    await page.getByRole('link', { name: 'View history' }).click()
    await expect(page.locator('.history-row')).toHaveCount(1)
    const views = page.getByRole('group', { name: 'View' })
    for (const name of ['Day', 'Week', 'Month', 'All time', 'Custom']) {
      await views.getByRole('button', { name }).click()
      expect(await smallTargets(page, ignore), `History ${name}`).toEqual([])
    }
    await views.getByRole('button', { name: 'Day' }).click()
    await page
      .getByRole('button', { name: /^Edit session/ })
      .first()
      .click()
    expect(await smallTargets(page, ignore), 'History edit form').toEqual([])
    await page.getByRole('button', { name: 'Cancel' }).click()
    await page
      .getByRole('button', { name: /^Archive session/ })
      .first()
      .click()
    await expect(page.getByText('Session archived.')).toBeVisible()
    expect(await smallTargets(page, ignore), 'archive undo').toEqual([])

    await openScreen(page, 'Archive')
    await expect(page.locator('.history-row')).toHaveCount(1)
    expect(await smallTargets(page, ignore)).toEqual([])
    await page.getByRole('button', { name: 'Delete all archived sessions' }).click()
    await expect(page.getByRole('alertdialog')).toBeVisible()
    expect(await smallTargets(page, ignore), 'delete-all dialog').toEqual([])
  })

  test('Sign out, the sign-out confirmation and the auth screens', async ({ page, context }) => {
    test.fixme(true, 'Bug #147: these are about 21 px tall')
    await installClock(page)
    await page.goto('/')
    expect(await smallTargets(page), 'sign in').toEqual([])
    await page.getByRole('button', { name: 'Create an account' }).click()
    expect(await smallTargets(page), 'sign up').toEqual([])
    await signUp(page, newEmail())
    expect(await smallTargets(page), 'account bar').toEqual([])
    await context.setOffline(true)
    await finishCountdown(page, { minutes: 1 })
    await page.getByRole('button', { name: 'New session' }).click()
    await page.getByRole('button', { name: 'Sign out' }).click()
    await expect(page.getByRole('alertdialog')).toBeVisible()
    expect(await smallTargets(page), 'sign-out confirmation').toEqual([])
  })

  test('Settings: every control is 44 px, the alert slider is full width with Preview below', async ({
    page,
  }) => {
    test.fixme(true, 'Bug #148: Preview buttons about 21 px, checkbox 13 px, alert slider 224 px')
    await installClock(page)
    await signUp(page, newEmail())
    await openScreen(page, 'Settings')
    await expect(page.getByRole('heading', { name: 'Settings' })).toBeVisible()
    expect(await smallTargets(page, ['Sign out'])).toEqual([])

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

test.describe('keyboard and screen readers', () => {
  test('setup is reachable in order and Enter starts a session', async ({ page }) => {
    await installClock(page)
    await signUp(page, newEmail())
    const order: string[] = []
    for (let i = 0; i < 11; i++) {
      await page.keyboard.press('Tab')
      order.push(
        await page.evaluate(() => {
          const el = document.activeElement as HTMLInputElement | null
          return (el?.labels?.[0]?.textContent ?? el?.textContent ?? el?.tagName ?? '').trim()
        }),
      )
    }
    expect(order.slice(0, 5)).toEqual(['Sign out', 'New session', 'History', 'Archive', 'Settings'])
    expect(order.at(-1)).toBe('Start')
    expect(order).toContain('Duration')

    await page.getByLabel('Duration').focus()
    await page.keyboard.press('Enter')
    await expect(page.getByRole('timer', { name: 'Time' })).toBeVisible()
    // Pause and Stop work with the keyboard too.
    await page.getByRole('button', { name: 'Pause' }).focus()
    await page.keyboard.press('Space')
    await expect(page.getByRole('button', { name: 'Resume' })).toBeVisible()
  })

  test('every control has an accessible name and errors are announced', async ({ page }) => {
    await installClock(page)
    await page.goto('/')
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

  test('focus is visible on every tab stop', async ({ page }) => {
    await installClock(page)
    await signUp(page, newEmail())
    for (let i = 0; i < 6; i++) {
      await page.keyboard.press('Tab')
      const ring = await page.evaluate(() => {
        const style = getComputedStyle(document.activeElement as Element)
        return { style: style.outlineStyle, width: parseFloat(style.outlineWidth) }
      })
      expect(ring.style).not.toBe('none')
      expect(ring.width).toBeGreaterThanOrEqual(2)
    }
  })

  test('the focus ring has 3:1 contrast on the light screens', async ({ page }) => {
    test.fixme(true, 'Bug #150: #8ab4f8 on white is about 2:1')
    await installClock(page)
    await signUp(page, newEmail())
    await page.keyboard.press('Tab')
    const ratio = await page.evaluate(() => {
      const channel = (c: number) => {
        const s = c / 255
        return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4
      }
      const luminance = (rgb: string) => {
        const [r, g, b] = (rgb.match(/\d+/g) ?? ['0', '0', '0']).map(Number)
        return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b)
      }
      const ring = luminance(getComputedStyle(document.activeElement as Element).outlineColor)
      const bg = getComputedStyle(document.body).backgroundColor
      // A transparent body shows the browser's white canvas.
      const page = luminance(bg === 'rgba(0, 0, 0, 0)' ? 'rgb(255, 255, 255)' : bg)
      const [hi, lo] = ring > page ? [ring, page] : [page, ring]
      return (hi + 0.05) / (lo + 0.05)
    })
    expect(ratio).toBeGreaterThanOrEqual(3)
  })

  test('focus moves to the new screen after Start and when the summary opens', async ({ page }) => {
    test.fixme(true, 'Bug #151: focus is left on <body>')
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

  test('Escape closes the sign-out confirmation', async ({ page, context }) => {
    test.fixme(true, 'Bug #151: Escape does nothing')
    await installClock(page)
    await signUp(page, newEmail())
    await context.setOffline(true)
    await finishCountdown(page, { minutes: 1 })
    await page.getByRole('button', { name: 'New session' }).click()
    await page.getByRole('button', { name: 'Sign out' }).click()
    await expect(page.getByRole('alertdialog')).toBeVisible()
    await page.keyboard.press('Escape')
    await expect(page.getByRole('alertdialog')).toHaveCount(0)
  })
})

test.describe('reduced motion', () => {
  test.use({ reducedMotion: 'reduce' })

  test('transitions and animations are switched off', async ({ page }) => {
    await installClock(page)
    await signUp(page, newEmail())
    await startCountdown(page, { minutes: 1 })
    const moving = await page.evaluate(() =>
      Array.from(document.querySelectorAll('*'))
        .filter((el) => {
          const s = getComputedStyle(el)
          return (
            (s.animationName !== 'none' && parseFloat(s.animationDuration) > 0.001) ||
            parseFloat(s.transitionDuration) > 0.001
          )
        })
        .map((el) => el.tagName.toLowerCase() + '.' + el.className),
    )
    expect(moving).toEqual([])
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
