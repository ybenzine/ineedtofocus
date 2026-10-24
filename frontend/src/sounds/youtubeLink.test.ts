import { describe, expect, it } from 'vitest'
import { checkYoutubeLink, normaliseYoutubeUrl, parseYoutubeLink } from './youtubeLink.ts'

const ID = 'dQw4w9WgXcQ'
const LIST = 'PLrAXtmErZgOeiKm4sgNOknGvNjby9efdf'

describe('parseYoutubeLink', () => {
  it.each([
    [`https://www.youtube.com/watch?v=${ID}`, { kind: 'video', id: ID }],
    [`https://youtu.be/${ID}?t=5`, { kind: 'video', id: ID }],
    [`https://m.youtube.com/watch?v=${ID}&list=${LIST}`, { kind: 'video', id: ID }],
    [`https://music.youtube.com/watch?v=${ID}`, { kind: 'video', id: ID }],
    [`https://www.youtube.com/shorts/${ID}`, { kind: 'video', id: ID }],
    [`https://www.youtube.com/live/${ID}`, { kind: 'video', id: ID }],
    [`https://www.youtube-nocookie.com/embed/${ID}`, { kind: 'video', id: ID }],
    [`https://youtube.com/playlist?list=${LIST}`, { kind: 'playlist', id: LIST }],
    [`http://www.youtube.com/watch?v=${ID}`, { kind: 'video', id: ID }],
    [`https://www.youtube.com:443/watch?v=${ID}`, { kind: 'video', id: ID }],
    [`HTTPS://WWW.YOUTUBE.COM/watch?v=${ID}`, { kind: 'video', id: ID }],
  ])('accepts %s', (raw, target) => {
    expect(parseYoutubeLink(raw)?.target).toEqual(target)
  })

  it('adds https:// to a link pasted without a scheme, and trims', () => {
    expect(normaliseYoutubeUrl(`  youtu.be/${ID}  `)).toBe(`https://youtu.be/${ID}`)
    expect(parseYoutubeLink(`  youtu.be/${ID}  `)).toEqual({
      url: `https://youtu.be/${ID}`,
      target: { kind: 'video', id: ID },
    })
  })

  it.each([
    ['', 'empty'],
    ['hello world', 'not a link'],
    [`https://vimeo.com/watch?v=${ID}`, 'other host'],
    [`https://youtube.com.evil.example/watch?v=${ID}`, 'look-alike host'],
    [`https://evil.example/?u=youtube.com&v=${ID}`, 'host in the query'],
    [`ftp://www.youtube.com/watch?v=${ID}`, 'other scheme'],
    [`javascript:alert(1)//youtu.be/${ID}`, 'javascript scheme'],
    [`https://www.youtube.com\\@evil.example/watch?v=${ID}`, 'backslash'],
    [`https://user@www.youtube.com/watch?v=${ID}`, 'userinfo'],
    [`https://www.youtube.com:8080/watch?v=${ID}`, 'other port'],
    [`https://www.youtube.com:80/watch?v=${ID}`, 'http port on https'],
    [`http://www.youtube.com:443/watch?v=${ID}`, 'https port on http'],
    [`https://www.youtube.com/watch?v=${ID}\nx`, 'newline'],
    [`https://www.youtube.com/watch?v=${ID}\tx`, 'tab'],
    [`https://www.youtube.com/watch?v=${ID} x`, 'space inside'],
    [`https://www.youtube.com/watch?v=${ID}\u200b`, 'invisible character'],
    [`https://www.youtu\u212ae.com/watch?v=${ID}`, 'non-ASCII host'],
    [`https://www.youtube.com/watch?v=${ID}&x=${'a'.repeat(2100)}`, 'too long'],
    [`https://youtu.be/${ID}/\u00ad`, 'soft hyphen'],
    [`https://www.youtube.com/watch?v=${ID}&x=\u180e`, 'Mongolian vowel separator'],
    [`https://www.youtube.com/watch?v=${ID}&x=\u2061`, 'function application'],
    [`https://www.youtube.com/watch?v=${ID}&x=\u206a`, 'inhibit symmetric swapping'],
    [`https://www.youtube.com/watch?v=${ID}&x=\u061c`, 'Arabic letter mark'],
    [`https://www.youtube.com/watch?v=${ID}&x=\ufff9`, 'interlinear annotation'],
    [`https://www.youtube.com/watch?v=${ID}&x=\ue000`, 'private use'],
    [`https://www.youtube.com/watch?v=${ID}&x=\u{e0001}`, 'language tag'],
    [`https://www.youtube.com/watch?v=${ID}&x=\u0378`, 'unassigned'],
    [`https://www.youtube.com/watch?v=${ID}&x=\u{10ffff}`, 'noncharacter'],
    [`https://www.youtub%65.com/watch?v=${ID}`, 'percent-encoded host'],
    [`https://www.youtube.com%2Fevil/watch?v=${ID}`, 'encoded slash in host'],
    ['https://www.youtube.com/', 'no video or playlist'],
    ['https://www.youtube.com/watch?v=short', 'bad id'],
    [`https://www.youtube.com/watch?v=${ID.replace('Q', '<')}`, 'id with markup'],
  ])('rejects %s (%s)', (raw) => {
    expect(parseYoutubeLink(raw)).toBeNull()
  })

  it('reads the list of /embed/videoseries as a playlist', () => {
    expect(
      parseYoutubeLink(`https://www.youtube.com/embed/videoseries?list=${LIST}`)?.target,
    ).toEqual({
      kind: 'playlist',
      id: LIST,
    })
  })

  it('tells a link with nothing to play from an invalid one', () => {
    for (const raw of ['https://www.youtube.com/@channel', 'https://youtu.be/', 'youtube.com']) {
      expect(checkYoutubeLink(raw)).toEqual({ ok: false, reason: 'no-id' })
    }
    expect(checkYoutubeLink('https://vimeo.com/x')).toEqual({ ok: false, reason: 'invalid' })
  })
})
