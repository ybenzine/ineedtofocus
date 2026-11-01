// The Tags API (#400): the user's custom tags under /api/tags.

import { isTagColor, type TagColor } from './palette.ts'

export interface CustomTag {
  id: string
  name: string
  color: TagColor
  createdAt: string
  /** Null while the tag is in use (AC7.7). */
  removedAt: string | null
}

/** The `details[0].type` of a 409; the app picks its message from this, never from the text. */
export type TagConflict =
  'name_taken' | 'removed_name_taken' | 'limit_in_use' | 'limit_total' | 'removed'

const CONFLICTS: readonly string[] = [
  'name_taken',
  'removed_name_taken',
  'limit_in_use',
  'limit_total',
  'removed',
]

export type TagsErrorKind =
  'network' | 'unauthorized' | 'conflict' | 'invalid' | 'missing' | 'server'

export class TagsError extends Error {
  readonly kind: TagsErrorKind
  /** For `conflict`: which one; undefined for a 409 of a kind this app doesn't know. */
  readonly conflict: TagConflict | undefined
  constructor(kind: TagsErrorKind, message: string, conflict?: TagConflict) {
    super(message)
    this.kind = kind
    this.conflict = conflict
  }
}

export interface TagInput {
  name?: string
  color?: TagColor
}

export interface TagsApi {
  list(signal?: AbortSignal): Promise<CustomTag[]>
  /** `restored` is true when the API brought a removed tag back (200) instead of making one (201). */
  create(
    input: { name: string; color: TagColor },
    signal?: AbortSignal,
  ): Promise<{ tag: CustomTag; restored: boolean }>
  update(id: string, input: TagInput, signal?: AbortSignal): Promise<CustomTag>
  remove(id: string, signal?: AbortSignal): Promise<CustomTag>
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

/** Reads one tag from untrusted JSON (the server or the device cache); null if it is malformed. */
export function parseTag(value: unknown): CustomTag | null {
  if (!isObject(value)) return null
  const { id, name, color, created_at, removed_at, createdAt, removedAt } = value
  const created = created_at ?? createdAt
  const removed = removed_at ?? removedAt ?? null
  if (
    typeof id !== 'string' ||
    id === '' ||
    typeof name !== 'string' ||
    !isTagColor(color) ||
    typeof created !== 'string' ||
    (removed !== null && typeof removed !== 'string')
  ) {
    return null
  }
  return { id, name, color, createdAt: created, removedAt: removed }
}

export function parseTagList(value: unknown): CustomTag[] {
  if (!Array.isArray(value)) return []
  return value.flatMap((item) => {
    const tag = parseTag(item)
    return tag ? [tag] : []
  })
}

async function conflictOf(response: Response): Promise<TagConflict | undefined> {
  try {
    const body = (await response.json()) as { error?: { details?: { type?: unknown }[] | null } }
    const type = body.error?.details?.[0]?.type
    return typeof type === 'string' && CONFLICTS.includes(type) ? (type as TagConflict) : undefined
  } catch {
    return undefined
  }
}

async function call(
  method: 'GET' | 'POST' | 'PATCH',
  path: string,
  body: unknown,
  signal?: AbortSignal,
): Promise<{ status: number; json: unknown }> {
  let response: Response
  try {
    response = await fetch(path, {
      method,
      credentials: 'same-origin',
      signal,
      headers: body === undefined ? undefined : { 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    })
  } catch {
    throw new TagsError('network', "Can't reach the server.")
  }
  if (response.status === 401) throw new TagsError('unauthorized', 'Not signed in.')
  if (response.status === 409) {
    throw new TagsError('conflict', 'Conflict.', await conflictOf(response))
  }
  // A malformed id (422) and an unknown one (404) both mean there is no such tag to change.
  if (response.status === 404) throw new TagsError('missing', 'No such tag.')
  if (response.status === 422) throw new TagsError('invalid', 'The server rejected the tag.')
  if (!response.ok) throw new TagsError('server', 'The server could not change tags.')
  try {
    return { status: response.status, json: await response.json() }
  } catch {
    throw new TagsError('server', 'Unreadable response.')
  }
}

function one(json: unknown): CustomTag {
  const tag = parseTag(json)
  if (!tag) throw new TagsError('server', 'Unreadable response.')
  return tag
}

export const httpTagsApi: TagsApi = {
  async list(signal) {
    const { json } = await call('GET', '/api/tags', undefined, signal)
    return parseTagList(isObject(json) ? json.tags : null)
  },
  async create(input, signal) {
    const { status, json } = await call('POST', '/api/tags', input, signal)
    return { tag: one(json), restored: status === 200 }
  },
  async update(id, input, signal) {
    const { json } = await call('PATCH', `/api/tags/${encodeURIComponent(id)}`, input, signal)
    return one(json)
  },
  async remove(id, signal) {
    const { json } = await call(
      'POST',
      `/api/tags/${encodeURIComponent(id)}/remove`,
      undefined,
      signal,
    )
    return one(json)
  },
}
