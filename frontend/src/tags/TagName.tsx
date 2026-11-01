import type { TagColor } from './palette.ts'
import { useTagsView } from './context.ts'

/** A decorative colour dot (AC7.8): the name is always beside it, so colour never stands alone. */
export function TagDot({ color }: { color: TagColor | null }) {
  if (color === null) return null
  return <span className={`tag-dot tag-dot-${color}`} aria-hidden="true" />
}

/** A tag's dot and name, read from the account's tag list. An unknown tag is "Tag", no dot. */
export default function TagName({ tag, className }: { tag: string; className?: string }) {
  const info = useTagsView().info(tag)
  return (
    <span className={className ? `tag-name ${className}` : 'tag-name'}>
      <TagDot color={info.color} />
      <span className="tag-name-text">{info.name}</span>
    </span>
  )
}
