import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { expect, test } from '@playwright/test'
import {
  PASSWORD,
  finishCountdown,
  installClock,
  newEmail,
  serverSessionCount,
  signUp,
} from './helpers'

// Telemetry privacy (observability.md): no goal text, email or password in the backend's logs.

const REPO_ROOT = fileURLToPath(new URL('../../', import.meta.url))

/** The app container's logs, or null when Docker or the stack's project isn't reachable here. */
function appLogs(): string | null {
  const project = process.env.E2E_COMPOSE_PROJECT
  const args = ['compose', ...(project ? ['-p', project] : []), 'logs', '--no-color', 'app']
  try {
    return execFileSync('docker', args, { cwd: REPO_ROOT, encoding: 'utf8', maxBuffer: 64 << 20 })
  } catch {
    return null
  }
}

test('the goal, email and password never reach the backend logs', async ({ page }) => {
  const logs = appLogs()
  test.skip(logs === null, 'needs `docker compose logs` for the stack under test')

  const email = newEmail()
  const goal = `private-goal-${Math.random().toString(36).slice(2, 10)}`
  await installClock(page)
  await signUp(page, email)
  await finishCountdown(page, { minutes: 1, goal })
  await expect.poll(() => serverSessionCount(page.request)).toBe(1)

  const after = appLogs() ?? ''
  expect(after.length).toBeGreaterThan(0)
  expect(after).not.toContain(goal)
  expect(after).not.toContain(email)
  expect(after).not.toContain(PASSWORD)
})
