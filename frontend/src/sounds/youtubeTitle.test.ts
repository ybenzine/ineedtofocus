import { describe, expect, it } from 'vitest'
import { trimYoutubeTitle, youtubeLabelText } from './youtubeTitle.ts'

describe('trimYoutubeTitle (#326)', () => {
  it('keeps a title of exactly 20 characters', () => {
    expect(trimYoutubeTitle('12345678901234567890')).toBe('12345678901234567890')
    expect(trimYoutubeTitle('short')).toBe('short')
  })

  it('cuts at the last space at or before character 20', () => {
    expect(trimYoutubeTitle('Relaxing rain sounds for deep sleep')).toBe('Relaxing rain…')
  })

  it('cuts at a space that is the 20th character', () => {
    // 19 letters, a space at 20, then more.
    expect(trimYoutubeTitle('abcdefghijklmnopqrs tuvwxyz')).toBe('abcdefghijklmnopqrs…')
  })

  it('cuts at 20 when there is no space in the first 20', () => {
    expect(trimYoutubeTitle('abcdefghijklmnopqrstuvwxyz abc')).toBe('abcdefghijklmnopqrst…')
    expect(trimYoutubeTitle('a'.repeat(30))).toBe(`${'a'.repeat(20)}…`)
  })

  it('counts graphemes, so emoji and accents are never split', () => {
    expect(trimYoutubeTitle('🌧️'.repeat(25))).toBe(`${'🌧️'.repeat(20)}…`)
    expect(trimYoutubeTitle('👨‍👩‍👧‍👦'.repeat(21))).toBe(`${'👨‍👩‍👧‍👦'.repeat(20)}…`)
    expect(trimYoutubeTitle('é'.repeat(21))).toBe(`${'é'.repeat(20)}…`)
    expect(trimYoutubeTitle('日本語の雨の音を聞きながら集中する時間のための音楽')).toBe(
      '日本語の雨の音を聞きながら集中する時間の…',
    )
    expect(trimYoutubeTitle('🌧️'.repeat(20))).toBe('🌧️'.repeat(20))
  })

  it('drops trailing spaces and punctuation before the ellipsis', () => {
    expect(trimYoutubeTitle('Rain, thunder, and wind sounds')).toBe('Rain, thunder, and…')
    expect(trimYoutubeTitle('Rain sounds, thunder and wind')).toBe('Rain sounds…')
    expect(trimYoutubeTitle('Piano - rain - sleep music ever')).toBe('Piano - rain…')
    expect(trimYoutubeTitle('abcdefghijklmnopqrs, tuvwxyz')).toBe('abcdefghijklmnopqrs…')
  })
})

describe('youtubeLabelText', () => {
  it('falls back to a generic name, never an id', () => {
    expect(youtubeLabelText('video', null)).toBe('YouTube video')
    expect(youtubeLabelText('video', '  ')).toBe('YouTube video')
    expect(youtubeLabelText('playlist', undefined)).toBe('YouTube playlist')
    expect(youtubeLabelText('playlist', 'Mix')).toBe('Mix')
  })
})
