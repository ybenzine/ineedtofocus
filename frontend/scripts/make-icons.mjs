// Regenerates the brand assets from the one source in brand-mark.mjs (#491):
//   public/favicon.svg
//   public/icons/{icon-192,icon-512,maskable-512,apple-touch-icon}.png
// The PNGs are rendered by the Chromium that Playwright already installs for the e2e tests:
//   npm ci && npx playwright install chromium && npm run icons
// Run it again after changing brand-mark.mjs and commit the results.

import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium } from '@playwright/test'
import { favicon, icon } from './brand-mark.mjs'

const root = join(dirname(fileURLToPath(import.meta.url)), '..', 'public')
const icons = join(root, 'icons')
mkdirSync(icons, { recursive: true })

writeFileSync(join(root, 'favicon.svg'), favicon() + '\n')

const TARGETS = [
  ['icon-192.png', 'any', 192],
  ['icon-512.png', 'any', 512],
  ['maskable-512.png', 'maskable', 512],
  ['apple-touch-icon.png', 'apple', 180],
]

const browser = await chromium.launch()
try {
  for (const [name, kind, size] of TARGETS) {
    const page = await browser.newPage({ viewport: { width: size, height: size } })
    // The tiles are full-bleed squares, so the screenshot has no transparent pixels (iOS needs that).
    const svg = icon(kind).replace('width="512" height="512"', `width="${size}" height="${size}"`)
    await page.setContent(`<body style="margin:0">${svg}</body>`)
    writeFileSync(join(icons, name), await page.screenshot({ type: 'png' }))
    await page.close()
  }
} finally {
  await browser.close()
}
