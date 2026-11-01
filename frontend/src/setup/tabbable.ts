// What Tab can reach inside a sheet, for its focus trap.

export const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'

/**
 * What Tab can reach: the focusable elements, except the radios it skips (one radio per group is
 * a tab stop: the checked one, or the first when none is checked).
 */
export function tabbable(root: HTMLElement): HTMLElement[] {
  const all = [...root.querySelectorAll<HTMLElement>(FOCUSABLE)]
  const stops = new Map<string, HTMLInputElement>()
  for (const el of all) {
    if (!(el instanceof HTMLInputElement) || el.type !== 'radio') continue
    const kept = stops.get(el.name)
    if (!kept || (el.checked && !kept.checked)) stops.set(el.name, el)
  }
  return all.filter(
    (el) => !(el instanceof HTMLInputElement && el.type === 'radio') || stops.get(el.name) === el,
  )
}
