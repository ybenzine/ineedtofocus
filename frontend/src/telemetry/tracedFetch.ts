/**
 * `fetch` that adds a W3C `traceparent` header, so the backend continues the browser's trace
 * and a save (or a history load) shares one trace ID from click to database (#31).
 *
 * The header holds random ids only: nothing about the user, the session or its goal.
 */

function randomHex(bytes: number): string {
  const values = crypto.getRandomValues(new Uint8Array(bytes))
  // All-zero ids are invalid in the spec. A random value is never all zero in practice, but
  // forcing one bit makes it certain.
  values[values.length - 1] |= 1
  return Array.from(values, (b) => b.toString(16).padStart(2, '0')).join('')
}

/** `00-<32 hex trace id>-<16 hex span id>-01` (version 00, sampled). */
export function newTraceparent(): string {
  return `00-${randomHex(16)}-${randomHex(8)}-01`
}

export const tracedFetch: typeof fetch = (input, init) => {
  const headers = new Headers(init?.headers)
  if (!headers.has('traceparent')) headers.set('traceparent', newTraceparent())
  return globalThis.fetch(input, { ...init, headers })
}
