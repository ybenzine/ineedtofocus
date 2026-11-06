import '@testing-library/jest-dom/vitest'
// jsdom has no IndexedDB; this in-memory implementation stands in for it (#19).
import 'fake-indexeddb/auto'
import { cleanup } from '@testing-library/react'
import { afterEach } from 'vitest'

// Several tests open the app's default database (createAppServices, `new IndexedDbSessionStore()`),
// which fake-indexeddb keeps for the whole file. Deleting every database after each test keeps
// what one test saved from showing up in the next one when tests run in a different order (#459).
afterEach(async () => {
  cleanup()
  // The app pushes `/settings`, `/history` ... to the history; a later test would deep-link there (#459).
  window.history.replaceState(null, '', '/')
  // Settings the app keeps on the device (audio source, ...) must not reach the next test either.
  window.localStorage.clear()
  for (const { name } of await indexedDB.databases()) {
    if (!name) continue
    await new Promise<void>((resolve, reject) => {
      const request = indexedDB.deleteDatabase(name)
      request.onsuccess = () => resolve()
      request.onerror = () => reject(new Error(`Deleting test database ${name} failed`))
      // A connection a test left open that doesn't close on versionchange.
      request.onblocked = () => reject(new Error(`Test database ${name} is still open`))
    })
  }
})
