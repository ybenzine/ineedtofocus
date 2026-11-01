// What the Tags section says (AC7.4, AC7.9, #401).

import { TagsError } from './api.ts'
import { TAGS_IN_USE_MAX, TAG_NAME_MAX } from './palette.ts'

export const BUILTIN_NOTE = "Built-in tags can't be changed."
export const OFFLINE_NOTE = 'Changing tags needs a connection.'
export const EMPTY_NAME = 'Enter a name for the tag.'
export const LONG_NAME = `Use ${TAG_NAME_MAX} characters or fewer.`

/** The text for a failed change; `reload` says whether the list should be fetched again. */
export function tagErrorMessage(error: unknown): { text: string; reload: boolean } {
  if (error instanceof TagsError) {
    if (error.kind === 'conflict') {
      switch (error.conflict) {
        case 'name_taken':
          return { text: 'A tag with this name already exists.', reload: false }
        case 'removed_name_taken':
          return {
            text: 'A removed tag has this name. Add a tag with this name to bring it back.',
            reload: false,
          }
        case 'limit_in_use':
          return {
            text: `You can have up to ${TAGS_IN_USE_MAX} tags of your own. Remove one to add another.`,
            reload: false,
          }
        case 'limit_total':
          return {
            text: "You've reached the limit of 100 tags, including removed ones.",
            reload: false,
          }
        case 'removed':
          return { text: 'This tag was removed on another device.', reload: true }
      }
    }
    if (error.kind === 'missing') {
      return { text: "That tag doesn't exist any more. The list was reloaded.", reload: true }
    }
    if (error.kind === 'unauthorized') {
      return { text: 'Your sign-in expired. Sign in again to change tags.', reload: false }
    }
  }
  return { text: "Couldn't change tags. Your tags are unchanged. Try again.", reload: false }
}
