import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

describe('main.tsx (AC1.9, #350)', () => {
  it('imports the module that takes the reset token out of the address bar before any other', () => {
    const source = readFileSync(join(process.cwd(), 'src', 'main.tsx'), 'utf8')
    const imports = [...source.matchAll(/^import\s+(?:[^'\n]*from\s+)?'([^']+)'/gm)].map(
      (m) => m[1],
    )
    expect(imports[0]).toBe('./auth/captureResetToken.ts')
  })
})
