// An in-memory Tags API that follows the server's rules (architecture.md → Tags, #400), for
// tests of the store and the Settings section.

import {
  TagsError,
  type CustomTag,
  type TagConflict,
  type TagInput,
  type TagsApi,
} from '../tags/api.ts'
import type { TagColor } from '../tags/palette.ts'

const BUILTIN_NAMES = ['work', 'study', 'nap', 'read', 'meditation', 'exercise']

export class FakeTagsApi implements TagsApi {
  tags: CustomTag[] = []
  calls: string[] = []
  /** When set, every call fails with this error (a network or server failure). */
  failWith: TagsError | null = null
  #next = 1

  add(name: string, color: TagColor = 'blue', removed = false): CustomTag {
    const tag: CustomTag = {
      id: `00000000-0000-4000-8000-${String(this.#next++).padStart(12, '0')}`,
      name,
      color,
      createdAt: `2026-11-01T10:00:${String(this.#next).padStart(2, '0')}Z`,
      removedAt: removed ? '2026-11-01T11:00:00Z' : null,
    }
    this.tags.push(tag)
    return tag
  }

  #check(): void {
    if (this.failWith) throw this.failWith
  }

  #conflict(type: TagConflict): never {
    throw new TagsError('conflict', 'Conflict.', type)
  }

  #inUse(): CustomTag[] {
    return this.tags.filter((t) => t.removedAt === null)
  }

  #byName(name: string): CustomTag | undefined {
    return this.tags.find((t) => t.name.toLowerCase() === name.toLowerCase())
  }

  async list(): Promise<CustomTag[]> {
    this.calls.push('list')
    this.#check()
    return this.tags.map((t) => ({ ...t }))
  }

  async create(input: { name: string; color: TagColor }) {
    this.calls.push(`create ${input.name}`)
    this.#check()
    const same = this.#byName(input.name)
    if (BUILTIN_NAMES.includes(input.name.toLowerCase()) || (same && same.removedAt === null)) {
      this.#conflict('name_taken')
    }
    if (same) {
      if (this.#inUse().length >= 20) this.#conflict('limit_in_use')
      same.removedAt = null
      same.color = input.color
      return { tag: { ...same }, restored: true }
    }
    if (this.#inUse().length >= 20) this.#conflict('limit_in_use')
    if (this.tags.length >= 100) this.#conflict('limit_total')
    return { tag: { ...this.add(input.name, input.color) }, restored: false }
  }

  async update(id: string, input: TagInput) {
    this.calls.push(`update ${id}`)
    this.#check()
    const tag = this.tags.find((t) => t.id === id)
    if (!tag) throw new TagsError('missing', 'No such tag.')
    if (tag.removedAt !== null) this.#conflict('removed')
    if (input.name !== undefined) {
      const same = this.#byName(input.name)
      if (BUILTIN_NAMES.includes(input.name.toLowerCase())) this.#conflict('name_taken')
      if (same && same.id !== id) {
        this.#conflict(same.removedAt === null ? 'name_taken' : 'removed_name_taken')
      }
      tag.name = input.name
    }
    if (input.color !== undefined) tag.color = input.color
    return { ...tag }
  }

  async remove(id: string) {
    this.calls.push(`remove ${id}`)
    this.#check()
    const tag = this.tags.find((t) => t.id === id)
    if (!tag) throw new TagsError('missing', 'No such tag.')
    tag.removedAt ??= '2026-11-01T12:00:00Z'
    return { ...tag }
  }
}
