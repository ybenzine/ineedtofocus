import '@testing-library/jest-dom/vitest'
// jsdom has no IndexedDB; this in-memory implementation stands in for it (#19).
import 'fake-indexeddb/auto'
import { cleanup } from '@testing-library/react'
import { afterEach } from 'vitest'

afterEach(() => {
  cleanup()
})
