// What every screen needs to know about tags, built from the custom tag list (AC7.8, #401).
//
// One order everywhere a list of tags is offered: the six built-in tags, then custom tags oldest
// first (in the History filter, removed ones after those in use). Name and colour of any tag id
// come from here; an id this device doesn't know shows as "Tag" with no dot and never throws.

import { TAGS } from '../timer/config.ts'
import type { CustomTag } from './api.ts'
import { BUILTIN_COLORS, TAG_COLORS, isBuiltinTag, type TagColor } from './palette.ts'

export interface TagInfo {
  id: string
  name: string
  /** Null for a tag this device doesn't know: no dot. */
  color: TagColor | null
  builtin: boolean
  removed: boolean
}

export const UNKNOWN_TAG_NAME = 'Tag'

function builtinName(id: string): string {
  return id.charAt(0).toUpperCase() + id.slice(1)
}

export interface TagsView {
  /** Built-in tags, then custom tags in use, oldest first: the setup picker and edit form. */
  pickable: readonly TagInfo[]
  /** `pickable`, then removed custom tags: the History filter. */
  all: readonly TagInfo[]
  /** Custom tags in use, oldest first. */
  custom: readonly TagInfo[]
  info(id: string): TagInfo
  /** Position in the AC7.8 order; unknown ids sort last. */
  rank(id: string): number
}

export function buildTagsView(tags: readonly CustomTag[]): TagsView {
  const builtin: TagInfo[] = TAGS.map((id) => ({
    id,
    name: builtinName(id),
    color: BUILTIN_COLORS[id],
    builtin: true,
    removed: false,
  }))
  const customInfo = (t: CustomTag): TagInfo => ({
    id: t.id,
    name: t.name,
    color: t.color,
    builtin: false,
    removed: t.removedAt !== null,
  })
  const inUse = tags.filter((t) => t.removedAt === null).map(customInfo)
  const removed = tags.filter((t) => t.removedAt !== null).map(customInfo)
  const byId = new Map<string, TagInfo>([...builtin, ...tags.map(customInfo)].map((t) => [t.id, t]))
  const all = [...builtin, ...inUse, ...removed]
  const ranks = new Map(all.map((t, i) => [t.id, i]))
  return {
    pickable: [...builtin, ...inUse],
    all,
    custom: inUse,
    info: (id) =>
      byId.get(id) ?? {
        id,
        name: isBuiltinTag(id) ? builtinName(id) : UNKNOWN_TAG_NAME,
        color: null,
        builtin: false,
        removed: false,
      },
    rank: (id) => ranks.get(id) ?? all.length,
  }
}

/**
 * AC7.5: the first palette colour that no tag in use (built-in, or custom and not removed) has,
 * or Indigo if all are taken.
 */
export function firstFreeColor(tags: readonly CustomTag[]): TagColor {
  const taken = new Set<TagColor>([
    ...Object.values(BUILTIN_COLORS),
    ...tags.filter((t) => t.removedAt === null).map((t) => t.color),
  ])
  return TAG_COLORS.find((c) => !taken.has(c.id))?.id ?? 'indigo'
}

/** Totals sorted most focus first, ties in AC7.8's order. */
export function sortByFocus<T extends { tag: string; focusSeconds: number }>(
  totals: readonly T[],
  view: TagsView,
): T[] {
  return [...totals].sort(
    (a, b) => b.focusSeconds - a.focusSeconds || view.rank(a.tag) - view.rank(b.tag),
  )
}
