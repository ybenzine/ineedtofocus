import { describe, expect, it } from 'vitest'
import type { CustomTag } from './api.ts'
import { BUILTIN_COLORS, normalizeTagName, type TagColor } from './palette.ts'
import { buildTagsView, firstFreeColor, sortByFocus } from './view.ts'

const tag = (
  id: string,
  name: string,
  color: TagColor,
  removed = false,
  createdAt = '2026-11-01T10:00:00Z',
): CustomTag => ({ id, name, color, createdAt, removedAt: removed ? '2026-11-02T10:00:00Z' : null })

describe('built-in colours (AC7.5)', () => {
  it('are Work Indigo, Study Blue, Nap Pink, Read Orange, Meditation Teal, Exercise Green', () => {
    expect(BUILTIN_COLORS).toEqual({
      work: 'indigo',
      study: 'blue',
      nap: 'pink',
      read: 'orange',
      meditation: 'teal',
      exercise: 'green',
    })
  })
})

describe('buildTagsView (AC7.8)', () => {
  const tags = [
    tag('a', 'Deep work', 'teal'),
    tag('b', 'Old', 'red', true),
    tag('c', 'Writing', 'yellow'),
  ]
  const view = buildTagsView(tags)

  it('offers built-in tags, then custom tags in use, oldest first', () => {
    expect(view.pickable.map((t) => t.name)).toEqual([
      'Work',
      'Study',
      'Nap',
      'Read',
      'Meditation',
      'Exercise',
      'Deep work',
      'Writing',
    ])
  })

  it('lists removed tags last in the filter order', () => {
    expect(view.all.map((t) => t.name).slice(-3)).toEqual(['Deep work', 'Writing', 'Old'])
    expect(view.all.at(-1)?.removed).toBe(true)
  })

  it('knows the name and colour of removed tags too', () => {
    expect(view.info('b')).toMatchObject({ name: 'Old', color: 'red', removed: true })
  })

  it('shows an unknown id as "Tag" with no dot, and never throws', () => {
    expect(view.info('not-loaded-yet')).toMatchObject({ name: 'Tag', color: null })
    expect(view.rank('not-loaded-yet')).toBeGreaterThan(view.rank('b'))
  })
})

describe('firstFreeColor (AC7.5)', () => {
  it('starts on Yellow, the first colour the built-in tags do not use', () => {
    expect(firstFreeColor([])).toBe('yellow')
  })

  it('moves on past the colours of custom tags in use, ignoring removed ones', () => {
    expect(firstFreeColor([tag('a', 'A', 'yellow')])).toBe('red')
    expect(firstFreeColor([tag('a', 'A', 'yellow', true)])).toBe('yellow')
  })

  it('falls back to Indigo when all eight are taken', () => {
    expect(firstFreeColor([tag('a', 'A', 'yellow'), tag('b', 'B', 'red')])).toBe('indigo')
  })
})

describe('sortByFocus', () => {
  it('puts most focus first and breaks ties in the AC7.8 order', () => {
    const view = buildTagsView([tag('a', 'A', 'red', true), tag('b', 'B', 'red')])
    const sorted = sortByFocus(
      [
        { tag: 'b', focusSeconds: 60 },
        { tag: 'nap', focusSeconds: 60 },
        { tag: 'a', focusSeconds: 60 },
        { tag: 'work', focusSeconds: 600 },
        { tag: 'study', focusSeconds: 60 },
      ],
      view,
    )
    expect(sorted.map((t) => t.tag)).toEqual(['work', 'study', 'nap', 'a', 'b'])
  })
})

describe('normalizeTagName (AC7.4)', () => {
  it('trims and turns each run of line breaks into one space', () => {
    expect(normalizeTagName('  Deep\n\r\n work \n')).toBe('Deep work')
    expect(normalizeTagName('a b')).toBe('a b')
  })
})
