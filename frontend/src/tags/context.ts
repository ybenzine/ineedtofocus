import { createContext, useContext, useMemo, useSyncExternalStore } from 'react'
import { TagsStore, type TagsState } from './store.ts'
import { buildTagsView, type TagsView } from './view.ts'

// Outside a provider (tests of single screens) there are only the six built-in tags.
const fallback = new TagsStore()

export const TagsContext = createContext<TagsStore>(fallback)

export function useTagsStore(): TagsStore {
  return useContext(TagsContext)
}

export function useTagsState(): TagsState {
  const store = useTagsStore()
  return useSyncExternalStore(store.subscribe, store.getState)
}

/** Names, colours and order of every tag, from the account's cached list (AC7.8). */
export function useTagsView(): TagsView {
  const { tags } = useTagsState()
  return useMemo(() => buildTagsView(tags), [tags])
}
