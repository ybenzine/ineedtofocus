// jsdom has no layout, so these pin the CSS rules that keep the screens inside a 360 px viewport (#131).
// The real check is a browser run at 360 x 740: document.documentElement.scrollWidth must equal 360.
import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

// Vitest runs from frontend/ (the npm script's cwd).
const css = readFileSync(resolve(process.cwd(), 'src/index.css'), 'utf8')

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
