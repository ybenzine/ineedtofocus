import type { Tag } from '../timer/config.ts'
import type { CustomTag } from '../tags/api.ts'
import { buildTagsView } from '../tags/view.ts'

/** AC7.3 */
export const GOAL_MAX_LENGTH = 120

/** AC8.1. The choice is only recorded here; playback arrives with #17 (Rain) and #18 (YouTube). */
export const AUDIO_SOURCES = ['none', 'rain', 'youtube'] as const
export type AudioSource = (typeof AUDIO_SOURCES)[number]

/**
 * Display name of a tag: a built-in key with its first letter upper-case, a custom tag's own
 * name as typed (AC7.8) when `custom` lists it, else "Tag". Option values stay the key or id.
 */
export function tagLabel(tag: Tag, custom: readonly CustomTag[] = []): string {
  return buildTagsView(custom).info(tag).name
}
