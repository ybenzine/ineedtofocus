import { useEffect, useState } from 'react'

/** The width from which the screens are text tabs in the header instead of a bottom bar (provisional, #406). */
export const WIDE_QUERY = '(min-width: 768px)'

/** True from 768 px wide. Without `matchMedia` (jsdom) the screen counts as a phone. */
export function useWideScreen(): boolean {
  const [wide, setWide] = useState(
    () => typeof window.matchMedia === 'function' && window.matchMedia(WIDE_QUERY).matches,
  )
  useEffect(() => {
    if (typeof window.matchMedia !== 'function') return
    const query = window.matchMedia(WIDE_QUERY)
    const update = () => setWide(query.matches)
    update()
    query.addEventListener('change', update)
    return () => query.removeEventListener('change', update)
  }, [])
  return wide
}
