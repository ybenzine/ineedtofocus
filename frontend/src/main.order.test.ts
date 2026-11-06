import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

describe('main.tsx (AC1.9, #350)', () => {
  it('imports the module that takes the reset token out of the address bar before any other', () => {
    const source = readFileSync(join(process.cwd(), 'src', 'main.tsx'), 'utf8')
    // The first import statement of any shape (a multi-line one starts with `import {`).
    const first = source.split('\n').find((line) => /^import\b/.test(line))
    expect(first).toBe("import './auth/captureResetToken.ts'")
  })
})
