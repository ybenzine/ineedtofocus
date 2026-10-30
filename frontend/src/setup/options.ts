import type { Tag } from '../timer/config.ts'

/** AC7.3 */
export const GOAL_MAX_LENGTH = 120

/** AC8.1. The choice is only recorded here; playback arrives with #17 (Rain) and #18 (YouTube). */
export const AUDIO_SOURCES = ['none', 'rain', 'youtube'] as const
export type AudioSource = (typeof AUDIO_SOURCES)[number]

/** Display label for a tag key: first letter upper-case. Option values stay the lowercase key. */
export function tagLabel(tag: Tag): string {
  return tag.charAt(0).toUpperCase() + tag.slice(1)
}
