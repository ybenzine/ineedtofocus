// Draws the app icons (a calm focus ring on the dark background) into public/icons/.
// Dependency-free so it runs anywhere Node does: `node scripts/make-icons.mjs`.
// The ring stays inside the central 60% of the canvas, so one drawing also works as a
// maskable icon (the safe zone is the central 80%).

import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { deflateSync } from 'node:zlib'

const BACKGROUND = [0x0e, 0x11, 0x16]
const RING = [0x8a, 0xb4, 0xf8]
const SAMPLES = 4 // supersampling per axis, for smooth edges

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
  return c >>> 0
})

function crc32(buffer) {
  let c = 0xffffffff
  for (const byte of buffer) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}

function chunk(type, data) {
  const length = Buffer.alloc(4)
  length.writeUInt32BE(data.length)
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data])
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(body))
  return Buffer.concat([length, body, crc])
}

/** Coverage of the ring (0..1) at pixel (x, y) of a size×size canvas. */
function ringCoverage(x, y, size) {
  const centre = size / 2
  const outer = size * 0.3
  const inner = size * 0.22
  const dot = size * 0.06
  let hits = 0
  for (let sy = 0; sy < SAMPLES; sy++) {
    for (let sx = 0; sx < SAMPLES; sx++) {
      const px = x + (sx + 0.5) / SAMPLES - centre
      const py = y + (sy + 0.5) / SAMPLES - centre
      const r = Math.hypot(px, py)
      if ((r <= outer && r >= inner) || r <= dot) hits++
    }
  }
  return hits / (SAMPLES * SAMPLES)
}

function png(size) {
  const rows = []
  for (let y = 0; y < size; y++) {
    const row = Buffer.alloc(1 + size * 3) // filter byte 0, then RGB
    for (let x = 0; x < size; x++) {
      const a = ringCoverage(x, y, size)
      for (let c = 0; c < 3; c++) {
        row[1 + x * 3 + c] = Math.round(BACKGROUND[c] * (1 - a) + RING[c] * a)
      }
    }
    rows.push(row)
  }
  const header = Buffer.alloc(13)
  header.writeUInt32BE(size, 0)
  header.writeUInt32BE(size, 4)
  header[8] = 8 // bit depth
  header[9] = 2 // colour type: RGB
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', header),
    chunk('IDAT', deflateSync(Buffer.concat(rows), { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ])
}

const out = join(dirname(fileURLToPath(import.meta.url)), '..', 'public', 'icons')
mkdirSync(out, { recursive: true })
for (const [name, size] of [
  ['icon-192.png', 192],
  ['icon-512.png', 512],
  ['maskable-512.png', 512],
  ['apple-touch-icon.png', 180],
]) {
  writeFileSync(join(out, name), png(size))
}
