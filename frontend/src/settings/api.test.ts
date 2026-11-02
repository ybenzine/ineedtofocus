import { describe, expect, it } from 'vitest'
import { DEFAULT_SETTINGS, parseSettings } from './api.ts'

const valid = {
  calendar_title_template: '{mode}: {tag}',
  calendar_include_goal: false,
  calendar_include_description: false,
  calendar_excluded_tags: ['nap', '5b0c3f1e-2a6d-4c8e-9f10-1a2b3c4d5e6f'],
  calendar_min_minutes: 10,
  calendar_name: 'Focus',
}

describe('parseSettings, calendar fields (AC12.8)', () => {
  it('reads valid values', () => {
    expect(parseSettings(valid)).toMatchObject(valid)
  })

  it('falls back to the defaults for invalid values', () => {
    const parsed = parseSettings({
      calendar_title_template: 5,
      calendar_include_goal: 'yes',
      calendar_include_description: null,
      calendar_excluded_tags: ['work', 3],
      calendar_min_minutes: 7,
      calendar_name: '',
    })
    for (const key of Object.keys(valid) as (keyof typeof valid)[]) {
      expect(parsed[key]).toEqual(DEFAULT_SETTINGS[key])
    }
    expect(parseSettings({ calendar_name: 'x'.repeat(61) }).calendar_name).toBe(
      DEFAULT_SETTINGS.calendar_name,
    )
    expect(
      parseSettings({ calendar_title_template: 'x'.repeat(121) }).calendar_title_template,
    ).toBe(DEFAULT_SETTINGS.calendar_title_template)
  })

  it('counts characters, not UTF-16 units, like the server', () => {
    const template = '😀'.repeat(120) // 240 UTF-16 units, 120 characters
    expect(parseSettings({ calendar_title_template: template }).calendar_title_template).toBe(
      template,
    )
    expect(
      parseSettings({ calendar_title_template: template + '😀' }).calendar_title_template,
    ).toBe(DEFAULT_SETTINGS.calendar_title_template)
    const name = '😀'.repeat(60)
    expect(parseSettings({ calendar_name: name }).calendar_name).toBe(name)
    expect(parseSettings({ calendar_name: name + '😀' }).calendar_name).toBe(
      DEFAULT_SETTINGS.calendar_name,
    )
  })
})
