import { render } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import YoutubeLabel, { PlayGlyph } from './YoutubeLabel.tsx'

// #344: a plain play glyph, not YouTube's mark.
describe('PlayGlyph', () => {
  it('is one filled triangle in the text colour, 16 px, hidden from assistive tech', () => {
    const { container } = render(<PlayGlyph />)
    const svg = container.querySelector('svg.play-glyph') as SVGElement
    expect(svg.querySelectorAll('path, polygon, rect, circle, ellipse')).toHaveLength(1)
    expect(svg.querySelector('rect')).toBeNull()
    expect((svg.querySelector('path') as SVGPathElement).getAttribute('fill')).toBe('currentColor')
    expect(svg.getAttribute('width')).toBe('16')
    expect(svg.getAttribute('height')).toBe('16')
    expect(svg.getAttribute('viewBox')).toBe('0 0 16 16')
    expect(svg.getAttribute('aria-hidden')).toBe('true')
    expect(svg.getAttribute('focusable')).toBe('false')
  })

  it('shows in a YouTube label unless showIcon is off', () => {
    const on = render(<YoutubeLabel kind="video" title="Quiet piano" />)
    expect(on.container.querySelectorAll('.play-glyph')).toHaveLength(1)
    const off = render(<YoutubeLabel kind="video" title="Quiet piano" showIcon={false} />)
    expect(off.container.querySelectorAll('.play-glyph')).toHaveLength(0)
  })
})
