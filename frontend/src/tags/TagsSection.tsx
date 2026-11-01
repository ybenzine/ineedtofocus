// Settings → Tags (AC7.4–AC7.9, #401): the six built-in tags, then the account's own, with add,
// rename, recolour and remove. Every change needs a connection and is sent before the list
// changes; the messages are picked from the API's 409 `type`, never from its text.

import { useId, useRef, useState, type FormEvent } from 'react'
import { useAnonymous } from '../anonymous/AnonymousContext.ts'
import { AuthLink } from '../anonymous/AuthLink.tsx'
import { useOnline } from '../sounds/useOnline.ts'
import { BUILTIN_NOTE, OFFLINE_NOTE, tagErrorMessage } from './messages.ts'
import { useTagsState, useTagsStore, useTagsView } from './context.ts'
import { TagDot } from './TagName.tsx'
import { TAG_COLORS, TAG_NAME_MAX, colorLabel, normalizeTagName, type TagColor } from './palette.ts'
import { EMPTY_NAME, LONG_NAME } from './messages.ts'
import { firstFreeColor, type TagInfo } from './view.ts'

/** The name as it would be sent, or the error the field shows (and nothing is sent). */
function checkName(text: string): { name: string; error: null } | { name: null; error: string } {
  const name = normalizeTagName(text)
  if (name === '') return { name: null, error: EMPTY_NAME }
  if ([...name].length > TAG_NAME_MAX) return { name: null, error: LONG_NAME }
  return { name, error: null }
}

function Swatches({
  legend,
  name,
  value,
  disabled,
  onChange,
}: {
  legend: string
  name: string
  value: TagColor
  disabled: boolean
  onChange: (color: TagColor) => void
}) {
  return (
    <fieldset className="tag-colors">
      <legend>{legend}</legend>
      <div className="choices">
        {TAG_COLORS.map((c) => (
          <label key={c.id} className="choice">
            <input
              type="radio"
              name={name}
              value={c.id}
              checked={value === c.id}
              disabled={disabled}
              onChange={() => onChange(c.id)}
            />
            <TagDot color={c.id} />
            <span>{c.label}</span>
          </label>
        ))}
      </div>
    </fieldset>
  )
}

function BuiltinTags({ tags }: { tags: readonly TagInfo[] }) {
  return (
    <ul className="tag-list" aria-label="Built-in tags">
      {tags.map((t) => (
        <li key={t.id}>
          <span className="tag-name">
            <TagDot color={t.color} />
            <span className="tag-name-text">{t.name}</span>
          </span>
        </li>
      ))}
    </ul>
  )
}

interface Message {
  kind: 'status' | 'error'
  text: string
}

export default function TagsSection() {
  const store = useTagsStore()
  const anonymous = useAnonymous() !== null
  const { tags } = useTagsState()
  const view = useTagsView()
  const online = useOnline()
  const id = useId()
  const builtin = view.pickable.filter((t) => t.builtin)

  const [draft, setDraft] = useState('')
  const [picked, setPicked] = useState<TagColor | null>(null)
  const [fieldError, setFieldError] = useState<string | null>(null)
  const [message, setMessage] = useState<Message | null>(null)
  const [busy, setBusy] = useState(false)
  const [renaming, setRenaming] = useState<string | null>(null)
  const [renameDraft, setRenameDraft] = useState('')
  const [renameError, setRenameError] = useState<string | null>(null)
  const [removing, setRemoving] = useState<string | null>(null)
  const addInput = useRef<HTMLInputElement>(null)

  const color = picked ?? firstFreeColor(tags)

  if (anonymous) {
    return (
      <div role="region" className="tags-section" aria-labelledby={`${id}-title`}>
        <h2 id={`${id}-title`}>Tags</h2>
        <BuiltinTags tags={builtin} />
        <p className="field-hint">{BUILTIN_NOTE}</p>
        <p className="field-hint">
          <AuthLink form="signup" origin="screen">
            Create an account
          </AuthLink>{' '}
          or{' '}
          <AuthLink form="signin" origin="screen">
            log in
          </AuthLink>{' '}
          to add your own tags.
        </p>
      </div>
    )
  }

  const canChange = online

  /** Runs one change; a failure shows its message and, when the list is stale, reloads it. */
  async function run<T>(change: () => Promise<T>): Promise<T | undefined> {
    setBusy(true)
    setMessage(null)
    try {
      return await change()
    } catch (error) {
      const { text, reload } = tagErrorMessage(error)
      setMessage({ kind: 'error', text })
      if (reload) await store.refresh()
      return undefined
    } finally {
      setBusy(false)
    }
  }

  async function add(event: FormEvent) {
    event.preventDefault()
    const checked = checkName(draft)
    if (checked.error !== null) {
      setFieldError(checked.error)
      return
    }
    setFieldError(null)
    const result = await run(() => store.create(checked.name, color))
    if (!result) return
    setDraft('')
    setPicked(null)
    setMessage({
      kind: 'status',
      text: result.restored
        ? `Brought back the tag ${result.tag.name}.`
        : `Added the tag ${result.tag.name}.`,
    })
    addInput.current?.focus()
  }

  async function saveRename(event: FormEvent, tag: TagInfo) {
    event.preventDefault()
    const checked = checkName(renameDraft)
    if (checked.error !== null) {
      setRenameError(checked.error)
      return
    }
    setRenameError(null)
    if (checked.name === tag.name) {
      setRenaming(null)
      return
    }
    const result = await run(() => store.update(tag.id, { name: checked.name }))
    if (!result) return
    setRenaming(null)
    setMessage({ kind: 'status', text: `Renamed the tag to ${result.name}.` })
  }

  async function recolor(tag: TagInfo, next: TagColor) {
    if (next === tag.color) return
    const result = await run(() => store.update(tag.id, { color: next }))
    if (result) {
      setMessage({ kind: 'status', text: `${result.name} is now ${colorLabel(next)}.` })
    }
  }

  async function confirmRemove(tag: TagInfo) {
    const result = await run(() => store.remove(tag.id))
    setRemoving(null)
    if (result) {
      setMessage({ kind: 'status', text: `Removed the tag ${tag.name}.` })
      addInput.current?.focus()
    }
  }

  return (
    <div role="region" className="tags-section" aria-labelledby={`${id}-title`}>
      <h2 id={`${id}-title`}>Tags</h2>
      <BuiltinTags tags={builtin} />
      <p className="field-hint">{BUILTIN_NOTE}</p>

      <h3>Your tags</h3>
      {view.custom.length === 0 ? (
        <p className="field-hint">You haven&apos;t added any tags yet.</p>
      ) : (
        <ul className="tag-list" aria-label="Your tags">
          {view.custom.map((tag) => (
            <li key={tag.id}>
              {renaming === tag.id && canChange ? (
                <form
                  className="tag-form"
                  onSubmit={(event) => void saveRename(event, tag)}
                  onKeyDown={(event) => {
                    if (event.key === 'Escape') setRenaming(null)
                  }}
                >
                  <div className="tag-field">
                    <label htmlFor={`${id}-rename-${tag.id}`}>New name for {tag.name}</label>
                    <input
                      id={`${id}-rename-${tag.id}`}
                      type="text"
                      autoComplete="off"
                      autoFocus
                      value={renameDraft}
                      aria-invalid={renameError ? true : undefined}
                      aria-describedby={renameError ? `${id}-rename-error` : undefined}
                      onChange={(event) => setRenameDraft(event.target.value)}
                    />
                    {renameError && (
                      <p id={`${id}-rename-error`} role="alert" className="field-error">
                        {renameError}
                      </p>
                    )}
                  </div>
                  <div className="tag-actions">
                    <button type="submit" className="primary" disabled={busy}>
                      Save
                    </button>
                    <button type="button" disabled={busy} onClick={() => setRenaming(null)}>
                      Cancel
                    </button>
                  </div>
                </form>
              ) : (
                <>
                  <span className="tag-name">
                    <TagDot color={tag.color} />
                    <span className="tag-name-text">{tag.name}</span>
                  </span>
                  {canChange && removing === tag.id ? (
                    <div role="group" aria-label={`Remove ${tag.name}`}>
                      <p>
                        Remove {tag.name}? It leaves the tag picker. Sessions that have it keep it.
                      </p>
                      <div className="tag-actions">
                        <button
                          type="button"
                          className="primary"
                          disabled={busy}
                          onClick={() => void confirmRemove(tag)}
                        >
                          Remove
                        </button>
                        <button
                          type="button"
                          autoFocus
                          disabled={busy}
                          onClick={() => setRemoving(null)}
                        >
                          Cancel
                        </button>
                      </div>
                    </div>
                  ) : (
                    canChange && (
                      <>
                        <Swatches
                          legend={`Colour of ${tag.name}`}
                          name={`${id}-color-${tag.id}`}
                          value={tag.color ?? 'indigo'}
                          disabled={busy}
                          onChange={(next) => void recolor(tag, next)}
                        />
                        <div className="tag-actions">
                          <button
                            type="button"
                            aria-label={`Rename ${tag.name}`}
                            disabled={busy}
                            onClick={() => {
                              setRenaming(tag.id)
                              setRenameDraft(tag.name)
                              setRenameError(null)
                              setRemoving(null)
                            }}
                          >
                            Rename
                          </button>
                          <button
                            type="button"
                            aria-label={`Remove ${tag.name}`}
                            disabled={busy}
                            onClick={() => {
                              setRemoving(tag.id)
                              setRenaming(null)
                            }}
                          >
                            Remove
                          </button>
                        </div>
                      </>
                    )
                  )}
                </>
              )}
            </li>
          ))}
        </ul>
      )}

      {canChange ? (
        <form className="tag-form" onSubmit={(event) => void add(event)} noValidate>
          <h3>Add a tag</h3>
          <div className="tag-field">
            <label htmlFor={`${id}-name`}>Tag name</label>
            <input
              id={`${id}-name`}
              ref={addInput}
              type="text"
              autoComplete="off"
              value={draft}
              aria-invalid={fieldError ? true : undefined}
              aria-describedby={fieldError ? `${id}-name-error` : `${id}-name-hint`}
              onChange={(event) => {
                setDraft(event.target.value)
                setFieldError(null)
              }}
            />
            {fieldError ? (
              <p id={`${id}-name-error`} role="alert" className="field-hint field-error">
                {fieldError}
              </p>
            ) : (
              <p id={`${id}-name-hint`} className="field-hint">
                Up to {TAG_NAME_MAX} characters.
              </p>
            )}
          </div>
          <Swatches
            legend="Colour"
            name={`${id}-new-color`}
            value={color}
            disabled={busy}
            onChange={setPicked}
          />
          <div className="tag-actions">
            <button type="submit" className="primary" disabled={busy}>
              Add tag
            </button>
          </div>
        </form>
      ) : (
        <p className="field-hint">{OFFLINE_NOTE}</p>
      )}

      <p role="status" className="field-hint">
        {message?.kind === 'status' ? message.text : ''}
      </p>
      {message?.kind === 'error' && (
        <p role="alert" className="field-hint field-error">
          {message.text}
        </p>
      )}
    </div>
  )
}
