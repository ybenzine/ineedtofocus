// jsdom has no layout, so these pin the CSS rules that keep the screens inside a 360 px viewport (#131).
// The real check is a browser run at 360 x 740: document.documentElement.scrollWidth must equal 360.
import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

// Resolved from this file, not the cwd, so it works however Vitest is started.
const css = readFileSync(resolve(dirname(fileURLToPath(import.meta.url)), 'index.css'), 'utf8')

function rule(selector: string): string {
  const match = css.match(new RegExp(`(?:^|\\n)${selector.replace('.', '\\.')}\\s*\\{([^}]*)\\}`))
  if (!match) throw new Error(`no rule for ${selector}`)
  return match[1] ?? ''
}

describe('360 px layout (#131)', () => {
  it('lets the body column shrink below its content instead of growing the page', () => {
    const body = rule('body')
    expect(body).toMatch(/grid-template-columns:\s*minmax\(0,\s*1fr\)/)
    expect(body).toMatch(/justify-items:\s*stretch/)
    expect(body).not.toMatch(/place-items:\s*center/)
  })

  it('centres the stretched main column on wide screens', () => {
    expect(rule('main')).toMatch(/margin-inline:\s*auto/)
  })

  it('wraps the Screens nav and the account bar', () => {
    expect(rule('.screen-nav')).toMatch(/flex-wrap:\s*wrap/)
    expect(rule('.account-bar')).toMatch(/flex-wrap:\s*wrap/)
    expect(rule('.account-bar')).toMatch(/overflow-wrap:\s*anywhere/)
  })

  it('breaks long goals in history rows', () => {
    expect(rule('.history-row-goal')).toMatch(/overflow-wrap:\s*anywhere/)
  })

  it("keeps YouTube's 200 px minimum height without a minimum width forcing overflow (#140)", () => {
    const player = rule('.youtube-player')
    expect(player).toMatch(/width:\s*100%/)
    expect(player).toMatch(/min-width:\s*0/)
    expect(player).toMatch(/aspect-ratio:\s*16\s*\/\s*9/)
    expect(player).toMatch(/min-height:\s*12\.5rem/)
  })
})

describe('danger buttons keep their colour (#238)', () => {
  // `button:hover:not(:disabled)` has higher specificity than `button.danger`, so each state that
  // changes a button's colour needs its own danger rule, using the error token.
  it.each([':hover:not(:disabled)', ':active:not(:disabled)', ':focus-visible'])(
    'has a button.danger%s rule that stays on --error',
    (state) => {
      const rules = [...css.matchAll(/([^{}]+)\{([^}]*)\}/g)]
      const found = rules.find(([, selectors]) =>
        (selectors ?? '').split(',').some((s) => s.trim() === `button.danger${state}`),
      )
      expect(found, `no rule for button.danger${state}`).toBeDefined()
      expect(found?.[2]).toMatch(/color:\s*var\(--error\)/)
      expect(found?.[2]).toMatch(/border-color:\s*var\(--error\)/)
    },
  )
})

describe('timer screen status gap (#286)', () => {
  it('takes back the flex gap of the empty status paragraph, without display: none', () => {
    const empty = rule(".timer-screen > \\[role='status'\\]:empty")
    expect(empty).toMatch(/margin-block-start:\s*calc\(-1 \* var\(--column-gap\)\)/)
    expect(empty).not.toMatch(/display:\s*none/)
    expect(rule('.timer-screen,\n.summary')).toMatch(/gap:\s*var\(--column-gap\)/)
  })
})

describe('fieldset legends are pills (#330)', () => {
  it('shares one rule between New session and Settings with the requested styles', () => {
    const match = css.match(/\.setup legend,\s*\.settings fieldset\.field legend\s*\{([^}]*)\}/)
    if (!match) throw new Error('no shared legend rule')
    const legend = match[1] ?? ''
    expect(legend).toMatch(/font-weight:\s*600/)
    expect(legend).toMatch(/background-color:\s*var\(--surface\)/)
    expect(legend).toMatch(/border:\s*1px solid var\(--border\)/)
    expect(legend).toMatch(/border-radius:\s*1rem/)
    expect(legend).toMatch(/padding:\s*0 10px/)
    expect(legend).toMatch(/display:\s*table/)
    expect(legend).toMatch(/margin:\s*0 auto/)
    expect(legend).toMatch(/max-width:\s*100%/)
  })
})
