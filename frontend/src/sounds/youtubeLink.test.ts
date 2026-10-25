/// <reference types="node" />
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
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

// The same cases run against the server in backend/tests/integration/test_settings.py, so the two
// checks can't drift. `sent` is the link the client saves and POSTs.
interface FixtureCase {
  url: string
  server_ok: boolean | null
  client_ok: boolean
  sent: string | null
  reason: string
}
// Resolved from this file, not the cwd, so it works however Vitest is started.
const HERE = dirname(fileURLToPath(import.meta.url))
// Read at test time, not imported: the Docker build type-checks the tests with only `frontend/`.
const SHARED = JSON.parse(
  readFileSync(resolve(HERE, '../../../_docs/api/fixtures/youtube-links.json'), 'utf8'),
) as FixtureCase[]

describe('shared client/server fixture', () => {
  it.each(SHARED.map((c) => [c.reason, c] as const))('%s', (_reason, c) => {
    const result = checkYoutubeLink(c.url)
    expect(result.ok).toBe(c.client_ok)
    if (result.ok) expect(result.link.url).toBe(c.sent)
    else expect(c.sent).toBeNull()
  })

  it('sends the server nothing but ASCII', () => {
    for (const c of SHARED) if (c.sent !== null) expect(c.sent).toMatch(/^[\x21-\x7e]+$/)
  })
})

describe('Unicode versions', () => {
  it.each([
    ['U+2FFC', '\u2ffc'],
    ['U+31EF', '\u31ef'],
    ['U+1CC00', '\u{1cc00}'],
    ['U+0897', '\u0897'],
    ['U+1FA89', '\u{1fa89}'],
  ])('percent-encodes %s, which newer Unicode assigns, so the server sees ASCII', (_n, char) => {
    const result = checkYoutubeLink(`https://youtu.be/${ID}?x=${char}`)
    expect(result.ok && result.link.url).toBe(
      `https://youtu.be/${ID}?x=${encodeURIComponent(char)}`,
    )
  })

  it('encodes the path and fragment too, and counts the length after encoding', () => {
    expect(parseYoutubeLink(`https://youtu.be/${ID}/\u00e9#\u00e9`)?.url).toBe(
      `https://youtu.be/${ID}/%C3%A9#%C3%A9`,
    )
    expect(parseYoutubeLink(`https://youtu.be/${ID}?x=${'\u00e9'.repeat(1000)}`)).toBeNull()
  })
})
