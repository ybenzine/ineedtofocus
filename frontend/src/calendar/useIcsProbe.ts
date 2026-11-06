import { useEffect, useState } from 'react'

/** How the server answered a check of the session's .ics (#458). */
export type IcsProbe = 'checking' | 'ok' | 'unauthorized' | 'failed'

/** An answer is trusted for this long; the menu asks again after it (the tap can't be async on iOS). */
export const PROBE_VALID_MS = 20_000
/** A probe that has not answered by then counts as failed. */
export const PROBE_TIMEOUT_MS = 8_000

/**
 * Asks the server, with a HEAD to the same URL the iOS link opens, whether that link would give
 * the user a calendar file (#458). A link that lands on a JSON error page strands the installed app,
 * which has no back button. Probes only while `enabled` (the menu is open); a reopened menu starts
 * over. The answer is kept for PROBE_VALID_MS, then asked again (the last answer stays meanwhile,
 * so nothing flickers), and when the app comes back to the foreground (visibilitychange, pageshow) the answer is dropped first, so it reads as checking. A 401 is reported,
 * never acted on: it signs nobody out. Answers that arrive after the menu closed or the path
 * changed are dropped.
 */
export function useIcsProbe(path: string, enabled: boolean): IcsProbe {
  const [answer, setAnswer] = useState<{ path: string; status: IcsProbe } | null>(null)

  useEffect(() => {
    if (!enabled) return
    let alive = true
    let controller: AbortController | null = null
    let refresh: ReturnType<typeof setTimeout> | undefined

    const run = () => {
      controller?.abort()
      clearTimeout(refresh)
      const mine = new AbortController()
      controller = mine
      const timeout = setTimeout(() => mine.abort(), PROBE_TIMEOUT_MS)
      const settle = (status: IcsProbe) => {
        clearTimeout(timeout)
        if (!alive || controller !== mine) return
        setAnswer({ path, status })
        refresh = setTimeout(run, PROBE_VALID_MS)
      }
      fetch(path, {
        method: 'HEAD',
        credentials: 'include',
        cache: 'no-store',
        signal: mine.signal,
      }).then(
        (response) =>
          settle(
            response.status === 200 ? 'ok' : response.status === 401 ? 'unauthorized' : 'failed',
          ),
        () => settle('failed'),
      )
    }
    // Back in the foreground the answer may be hours old (iOS suspends timers): drop it, so the
    // choice reads "Checking…" until a new one arrives. The 20 s re-check keeps it instead.
    const foreground = () => {
      if (document.visibilityState !== 'visible') return
      setAnswer(null)
      run()
    }
    run()
    document.addEventListener('visibilitychange', foreground)
    window.addEventListener('pageshow', foreground)
    return () => {
      alive = false
      controller?.abort()
      clearTimeout(refresh)
      document.removeEventListener('visibilitychange', foreground)
      window.removeEventListener('pageshow', foreground)
      setAnswer(null)
    }
  }, [path, enabled])

  return enabled && answer?.path === path ? answer.status : 'checking'
}
