// The one source of the I Need To Focus mark (#491, "Variation D"): a ¾ progress arc with a round
// cap over a dim track ring and a centre dot, white on an indigo gradient tile. Everything that
// shows the mark is built from these functions: public/favicon.svg, the PNG icons (make-icons.mjs)
// and the header mark in src/nav/AppShell.tsx (kept in step by src/nav/brand-mark.test.tsx).

export const ARC_FRACTION = 0.75
const TILE_FROM = '#8188ff'
const TILE_TO = '#3b3fc4'
const WHITE = '#ffffff'

/** Arc from 12 o'clock, clockwise, covering `frac` of the circle. */
export function arcPath(c, r, frac) {
  const a = 2 * Math.PI * frac
  const x = c + r * Math.sin(a)
  const y = c - r * Math.cos(a)
  const large = frac > 0.5 ? 1 : 0
  return `M${c} ${+(c - r).toFixed(3)}A${r} ${r} 0 ${large} 1 ${+x.toFixed(3)} ${+y.toFixed(3)}`
}

/** The track ring, arc and centre dot, centred at (c, c). */
function mark({ c, r, sw, dot, fg, trackOpacity }) {
  return (
    `<circle cx="${c}" cy="${c}" r="${r}" fill="none" stroke="${fg}" stroke-opacity="${trackOpacity}" stroke-width="${sw}"/>` +
    `<path d="${arcPath(c, r, ARC_FRACTION)}" fill="none" stroke="${fg}" stroke-width="${sw}" stroke-linecap="round"/>` +
    `<circle cx="${c}" cy="${c}" r="${dot}" fill="${fg}"/>`
  )
}

const TILE_GRADIENT =
  `<linearGradient id="t" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="${TILE_FROM}"/>` +
  `<stop offset="1" stop-color="${TILE_TO}"/></linearGradient>`

function svg(size, body, defs = '') {
  const d = defs ? `<defs>${defs}</defs>` : ''
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${size} ${size}" width="${size}" height="${size}">${d}${body}</svg>`
}

/** The mark inside a maskable icon is scaled down to stay inside the central 80% safe circle. */
const SCALE = { any: 1, apple: 1, maskable: 0.9 }

/** Full-bleed 512 square tile. kind: 'any' | 'maskable' | 'apple'. The OS rounds the corners. */
export function icon(kind) {
  const s = SCALE[kind]
  return svg(
    512,
    '<rect width="512" height="512" fill="url(#t)"/>' +
      mark({ c: 256, r: 138 * s, sw: 44 * s, dot: 34 * s, fg: WHITE, trackOpacity: 0.3 }),
    TILE_GRADIENT,
  )
}

/** The browser-tab icon: the same on a rounded tile, 32 px viewBox. */
export function favicon() {
  return svg(
    32,
    '<rect width="32" height="32" rx="7" fill="url(#t)"/>' +
      mark({ c: 16, r: 9.5, sw: 3.6, dot: 2.6, fg: WHITE, trackOpacity: 0.35 }),
    TILE_GRADIENT,
  )
}

/**
 * The header mark (24 px viewBox, shown at 22 px): a rounded tile in the theme's accent with the
 * mark in the page background. AppShell draws it with CSS variables; `tile` and `fg` are the
 * colours to use (hex, or `var(--accent)` / `var(--bg)`).
 */
export function header({ tile, fg }) {
  return svg(
    24,
    `<rect width="24" height="24" rx="6" fill="${tile}"/>` +
      mark({ c: 12, r: 6.6, sw: 2.5, dot: 1.9, fg, trackOpacity: 0.35 }),
  )
}
