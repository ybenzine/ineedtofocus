// The mark (#491) has one source, scripts/brand-mark.mjs. These keep the shipped files in step with
// it and with the manifest; if one fails, run `npm run icons` and commit the result.
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { favicon } from '../scripts/brand-mark.mjs'

const frontend = resolve(dirname(fileURLToPath(import.meta.url)), '..')

function ihdr(path: string) {
  const png = readFileSync(resolve(frontend, path))
  return { width: png.readUInt32BE(16), height: png.readUInt32BE(20), colourType: png[25] }
}

describe('brand assets (#491)', () => {
  it('ships a favicon.svg that is the source output', () => {
    expect(readFileSync(resolve(frontend, 'public/favicon.svg'), 'utf8').trim()).toBe(favicon())
  })

  it('has every manifest icon at its declared size', () => {
    const config = readFileSync(resolve(frontend, 'vite.config.ts'), 'utf8')
    const declared = [...config.matchAll(/src: '(\/icons\/[^']+\.png)',\s*sizes: '(\d+)x(\d+)'/g)]
    expect(declared).toHaveLength(3)
    for (const [, src, w, h] of declared) {
      const { width, height } = ihdr(`public${src}`)
      expect([width, height]).toEqual([Number(w), Number(h)])
    }
  })

  it('has an opaque 180 px apple-touch icon', () => {
    // PNG colour type 2 is RGB with no alpha channel; iOS paints transparency black.
    expect(ihdr('public/icons/apple-touch-icon.png')).toEqual({
      width: 180,
      height: 180,
      colourType: 2,
    })
  })
})
