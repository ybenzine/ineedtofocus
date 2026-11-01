// The tag colour palette and the built-in tags (AC7.5, #401).
//
// The eight colours are named here and valued in `index.css` (`--tag-<id>`, a dark and a light
// value each), so a dot is drawn with `var(--tag-indigo)` and follows the theme. The built-in
// tags are client constants: the server never serves them.

import { TAGS } from '../timer/config.ts'

export const TAG_COLORS = [
  { id: 'indigo', label: 'Indigo' },
  { id: 'blue', label: 'Blue' },
  { id: 'teal', label: 'Teal' },
  { id: 'green', label: 'Green' },
  { id: 'yellow', label: 'Yellow' },
  { id: 'orange', label: 'Orange' },
  { id: 'red', label: 'Red' },
  { id: 'pink', label: 'Pink' },
] as const

export type TagColor = (typeof TAG_COLORS)[number]['id']

export function isTagColor(value: unknown): value is TagColor {
  return TAG_COLORS.some((c) => c.id === value)
}

export function colorLabel(color: TagColor): string {
  return TAG_COLORS.find((c) => c.id === color)?.label ?? color
}

/** AC7.5: Work Indigo, Study Blue, Nap Pink, Read Orange, Meditation Teal, Exercise Green. */
export const BUILTIN_COLORS: Record<(typeof TAGS)[number], TagColor> = {
  work: 'indigo',
  study: 'blue',
  nap: 'pink',
  read: 'orange',
  meditation: 'teal',
  exercise: 'green',
}

export function isBuiltinTag(id: string): id is (typeof TAGS)[number] {
  return (TAGS as readonly string[]).includes(id)
}

/** AC7.4 */
export const TAG_NAME_MAX = 24
/** AC7.4: tags in use. */
export const TAGS_IN_USE_MAX = 20

/** The trimmed name with each run of line breaks as one space (AC7.4, as goals, AC7.3). */
export function normalizeTagName(text: string): string {
  // eslint-disable-next-line no-control-regex -- the control characters are the line breaks
  return text.replace(/\s*[\r\n\u000b\u000c\u001c-\u001e\u0085\u2028\u2029]+\s*/g, ' ').trim()
}
