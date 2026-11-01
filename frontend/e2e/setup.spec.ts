import { expect, test, type Page } from '@playwright/test'
import {
  closeSheet,
  expectNoSidewaysScroll,
  installClock,
  newEmail,
  openSheet,
  pickSound,
  pickTag,
  signUp,
  typeGoal,
} from './helpers'

// New session, dial first (#407): the setup journey and the layout, through the real stack.

const duration = (page: Page) => page.getByLabel('Duration in minutes, 1 to 240')

test('set up a countdown on the dial, keep it across Settings, start it and begin a new setup after', async ({
  page,
}) => {
  await installClock(page)
  await signUp(page, newEmail())

  // A new setup: 30 minutes, the 30 preset selected, Work, no goal, no sound.
  await expect(duration(page)).toHaveValue('30')
  await expect(page.getByRole('button', { name: '30 minutes' })).toHaveAttribute(
    'aria-pressed',
    'true',
  )
  await expect(page.getByTestId('dial-line')).toContainText('30m → ')

  // Presets and the buttons move the length; typing works too.
  await page.getByRole('button', { name: '90 minutes' }).click()
  await expect(duration(page)).toHaveValue('90')
  await expect(page.getByTestId('dial-line')).toContainText('1h 30m → ')
  await duration(page).fill('23')
  await page.getByRole('button', { name: '5 minutes less' }).click()
  await expect(duration(page)).toHaveValue('20')
  await page.getByRole('button', { name: '5 minutes more' }).click()
  await expect(duration(page)).toHaveValue('25')

  // The sheets.
  await pickTag(page, 'Study')
  await typeGoal(page, 'Chapter 4 problems')
  await pickSound(page, 'Rain')
  await expect(page.getByRole('button', { name: /^Tag\b.*Study/ })).toBeVisible()
  await expect(page.getByRole('button', { name: /^Goal\b.*Chapter 4 problems/ })).toBeVisible()
  await expect(page.getByRole('button', { name: /^Sound\b.*Rain/ })).toBeVisible()

  // Another screen and back: the setup is as it was left.
  await page
    .getByRole('navigation', { name: 'Screens' })
    .getByRole('button', { name: 'Settings' })
    .click()
  await expect(page.getByRole('heading', { name: 'Settings' })).toBeVisible()
  await page
    .getByRole('navigation', { name: 'Screens' })
    .getByRole('button', { name: 'New session' })
    .click()
  await expect(duration(page)).toHaveValue('25')
  await expect(page.getByRole('button', { name: /^Goal\b.*Chapter 4 problems/ })).toBeVisible()

  // Start, finish, and the next setup is a new one.
  await page.getByRole('button', { name: 'Start' }).click()
  await expect(page.getByRole('timer', { name: 'Time' })).toBeVisible()
  await page.clock.fastForward(26 * 60 * 1000)
  await expect(page.getByRole('heading', { name: 'Session complete' })).toBeVisible()
  await page.getByRole('button', { name: 'New session' }).click()
  await expect(duration(page)).toHaveValue('30')
  await expect(page.getByRole('button', { name: /^Goal\b.*Add a goal/ })).toBeVisible()
})

test('Pomodoro and Unlimited have their own dials', async ({ page }) => {
  await installClock(page)
  await signUp(page, newEmail())
  await page.getByRole('radio', { name: 'Pomodoro' }).check()
  await expect(page.getByTestId('dial-line')).toContainText('1h 55m → ')
  await page.getByRole('switch', { name: /long break/i }).check()
  await expect(page.getByLabel('Long break in minutes, 5 to 60')).toHaveValue('15')
  await page.getByRole('radio', { name: 'Unlimited' }).check()
  await page.getByRole('radio', { name: '15 minutes' }).check()
  await expect(page.locator('.dial-tick')).toHaveCount(4)
  await expect(page.getByTestId('dial-line')).toHaveText('chime every 15m')
})

test('a sheet traps focus, closes with Escape and returns focus to its row', async ({ page }) => {
  await installClock(page)
  await signUp(page, newEmail())
  const row = page.getByRole('button', { name: /^Tag\b/ })
  await openSheet(page, 'Tag')
  for (let i = 0; i < 20; i++) {
    await page.keyboard.press('Tab')
    expect(await page.evaluate(() => !!document.activeElement?.closest('[role="dialog"]'))).toBe(
      true,
    )
  }
  await page.keyboard.press('Escape')
  await expect(page.getByRole('dialog')).toHaveCount(0)
  await expect(row).toBeFocused()
  await openSheet(page, 'Sound')
  await closeSheet(page)
})

test('the Sound sheet keeps Tab inside with None or Rain chosen', async ({ page }) => {
  await installClock(page)
  await signUp(page, newEmail())
  for (const choice of ['None', 'Rain'] as const) {
    const sheet = await openSheet(page, 'Sound')
    await sheet.getByRole('radio', { name: choice }).check()
    for (const shift of [false, true]) {
      for (let i = 0; i < 6; i++) {
        await page.keyboard.press(shift ? 'Shift+Tab' : 'Tab')
        expect(
          await page.evaluate(() => !!document.activeElement?.closest('[role="dialog"]')),
        ).toBe(true)
      }
    }
    await closeSheet(page)
  }
})

const TARGETS = [
  'main button',
  'main label.mode-option span',
  'main input[type=text]',
  'main label.pill',
  'main label.switch-row',
  '[role=dialog] button',
  '[role=dialog] label.pill',
  '[role=dialog] a',
  '[role=dialog] input[type=text]',
].join(', ')

/** Names of the visible targets smaller than 44 px either way. */
async function smallTargets(page: Page): Promise<string[]> {
  return page.evaluate((selector) => {
    const small: string[] = []
    for (const el of document.querySelectorAll<HTMLElement>(selector)) {
      const box = el.getBoundingClientRect()
      if (box.height > 0 && (box.height < 43.5 || box.width < 43.5)) {
        const name = el.textContent?.trim() || el.getAttribute('aria-label') || el.tagName
        small.push(`${name} ${Math.round(box.width)}x${Math.round(box.height)}`)
      }
    }
    return small
  }, TARGETS)
}

test('every target is at least 44 x 44 px in every mode and both sheets, from 320 to 390 px wide', async ({
  page,
}) => {
  await installClock(page)
  await signUp(page, newEmail())
  for (const width of [320, 360, 375, 390]) {
    await page.setViewportSize({ width, height: 844 })
    const at = (what: string) => `${width}px, ${what}`
    await page.getByRole('radio', { name: 'Countdown' }).check()
    expect(await smallTargets(page), at('Countdown')).toEqual([])
    await page.getByRole('radio', { name: 'Pomodoro' }).check()
    await page.getByRole('switch', { name: /long break/i }).uncheck()
    expect(await smallTargets(page), at('Pomodoro')).toEqual([])
    await page.getByRole('switch', { name: /long break/i }).check()
    expect(await smallTargets(page), at('Pomodoro with Long break')).toEqual([])
    await page.getByRole('radio', { name: 'Unlimited' }).check()
    expect(await smallTargets(page), at('Unlimited')).toEqual([])
    await page.getByRole('radio', { name: 'Countdown' }).check()
    await openSheet(page, 'Tag')
    expect(await smallTargets(page), at('Tag & goal sheet')).toEqual([])
    await closeSheet(page)
    const sound = await openSheet(page, 'Sound')
    expect(await smallTargets(page), at('Sound sheet')).toEqual([])
    await sound.getByRole('radio', { name: 'YouTube' }).check()
    expect(await smallTargets(page), at('Sound sheet, YouTube')).toEqual([])
    await sound.getByRole('radio', { name: 'None' }).check()
    await closeSheet(page)
  }
})

// WCAG 2.4.11: a control that takes focus is never left behind the pinned Start.
for (const [width, height] of [
  [360, 640],
  [320, 568],
  [375, 667],
] as const) {
  test(`Tab never leaves a focused control behind Start at ${width}x${height}`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height })
    await installClock(page)
    await signUp(page, newEmail())
    for (const [mode, longBreak] of [
      ['Countdown', false],
      ['Pomodoro', false],
      ['Pomodoro', true],
      ['Unlimited', false],
    ] as const) {
      await page.getByRole('radio', { name: mode }).check()
      if (mode === 'Pomodoro') {
        await page.getByRole('switch', { name: /long break/i })[longBreak ? 'check' : 'uncheck']()
      }
      await page.evaluate(() => window.scrollTo(0, 0))
      await page.locator('.dial-input, .dial-infinity').first().focus()
      const seen: string[] = []
      for (let i = 0; i < 40; i++) {
        await page.keyboard.press('Tab')
        const state = await page.evaluate(() => {
          const el = document.activeElement as HTMLElement
          const footer = document.querySelector('.setup-footer')?.getBoundingClientRect()
          const box = el.getBoundingClientRect()
          return {
            name: el.textContent?.trim() || el.getAttribute('aria-label') || el.tagName,
            bottom: box.bottom,
            footerTop: footer?.top ?? 0,
            isStart: el.classList.contains('start-button'),
          }
        })
        if (state.isStart) break
        seen.push(state.name)
        expect(
          state.bottom,
          `${mode}${longBreak ? ' + long break' : ''}: "${state.name}" is behind Start`,
        ).toBeLessThanOrEqual(state.footerTop + 0.5)
      }
      expect(seen.length, `${mode}: reached Start`).toBeGreaterThan(3)
    }
  })
}

// Layout: no sideways scroll and Start in view at a small phone, a phone and a desktop; at 390 x 844
// the whole screen fits without scrolling, in each mode and both themes.
for (const scheme of ['dark', 'light'] as const) {
  for (const [width, height] of [
    [360, 640],
    [390, 844],
    [1280, 800],
  ] as const) {
    test.describe(`${width}x${height}, ${scheme}`, () => {
      test.use({ viewport: { width, height }, colorScheme: scheme })

      for (const mode of ['Countdown', 'Pomodoro', 'Unlimited'] as const) {
        test(`${mode}: no sideways scroll and Start is visible`, async ({ page }) => {
          await installClock(page)
          await signUp(page, newEmail())
          await page.getByRole('radio', { name: mode }).check()
          await expectNoSidewaysScroll(page)
          const start = page.getByRole('button', { name: 'Start' })
          await expect(start).toBeInViewport({ ratio: 1 })
          if (width === 390) {
            const overflow = await page.evaluate(
              () => document.documentElement.scrollHeight - document.documentElement.clientHeight,
            )
            expect(overflow).toBeLessThanOrEqual(0)
          }
        })
      }

      if (width === 390) {
        test('Pomodoro with the Long break on fits without scrolling', async ({ page }) => {
          await installClock(page)
          await signUp(page, newEmail())
          await page.getByRole('radio', { name: 'Pomodoro' }).check()
          await page.getByRole('switch', { name: /long break/i }).check()
          await expect(page.getByLabel('Long break in minutes, 5 to 60')).toBeVisible()
          await expect(page.getByRole('button', { name: 'Start' })).toBeInViewport({ ratio: 1 })
          const overflow = await page.evaluate(
            () => document.documentElement.scrollHeight - document.documentElement.clientHeight,
          )
          expect(overflow).toBeLessThanOrEqual(0)
        })
      }

      test('the touch targets are at least 44 px', async ({ page }) => {
        await installClock(page)
        await signUp(page, newEmail())
        const small = await page.evaluate(() =>
          [
            ...document.querySelectorAll<HTMLElement>(
              'main button, main label.mode-option span, main input[type=text]',
            ),
          ]
            .map((el) => ({
              name: el.textContent?.trim() || el.getAttribute('aria-label'),
              box: el.getBoundingClientRect(),
            }))
            .filter(({ box }) => box.height > 0 && (box.height < 43.5 || box.width < 43.5))
            .map(({ name }) => name),
        )
        expect(small).toEqual([])
      })
    })
  }
}
