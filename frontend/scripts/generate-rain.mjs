// Generates the rain loop (AC8.3): 30 s of steady rain as a mono 16-bit WAV that loops without
// a seam. Synthesised from seeded noise, so it is an original work with no third-party license
// (see _docs/assets.md) and the output is identical on every run.
// Run from frontend/: node scripts/generate-rain.mjs
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const RATE = 8000
const SECONDS = 30
const N = RATE * SECONDS
const out = join(dirname(fileURLToPath(import.meta.url)), '..', 'public', 'audio')

function mulberry32(seed) {
  let a = seed
  return () => {
    a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}
const random = mulberry32(17)

// Wrap-around: the filter below runs over the signal twice and keeps the second pass, and
// droplet tails wrap past the end to the start, so the last sample flows into the first.
const white = Float32Array.from({ length: N }, () => random() * 2 - 1)
const hiss = new Float32Array(N)
{
  let a = 0
  let b = 0
  let slow = 0
  for (let round = 0; round < 2; round++) {
    for (let i = 0; i < N; i++) {
      // Bed: soft hiss, two low-pass stages minus a slow drift (no rumble).
      a += 0.55 * (white[i] - a)
      b += 0.7 * (a - b)
      slow += 0.004 * (b - slow)
      if (round === 1) hiss[i] = b - slow
    }
  }
}

// Drops: short decaying tones at random pitches, wrapped around the loop end.
const drops = new Float32Array(N)
const dropCount = SECONDS * 70
for (let d = 0; d < dropCount; d++) {
  const start = Math.floor(random() * N)
  const freq = 900 + random() * 2600
  const amp = (0.15 + random() * random() * 0.85) * 0.9
  const tau = (0.002 + random() * 0.006) * RATE
  const length = Math.floor(tau * 6)
  for (let k = 0; k < length; k++) {
    drops[(start + k) % N] += amp * Math.exp(-k / tau) * Math.sin((2 * Math.PI * freq * k) / RATE)
  }
}

// A slow swell (whole cycles per loop, so it joins up) keeps the hiss from sounding like a tone.
const samples = new Float32Array(N)
let peak = 0
for (let i = 0; i < N; i++) {
  const t = i / N
  const swell = 1 + 0.12 * Math.sin(2 * Math.PI * 3 * t) + 0.08 * Math.sin(2 * Math.PI * 7 * t + 1)
  samples[i] = hiss[i] * swell * 1.4 + drops[i]
  peak = Math.max(peak, Math.abs(samples[i]))
}

const data = Buffer.alloc(N * 2)
samples.forEach((s, i) => data.writeInt16LE(Math.round((s / peak) * 0.7 * 32767), i * 2))
const header = Buffer.alloc(44)
header.write('RIFF', 0)
header.writeUInt32LE(36 + data.length, 4)
header.write('WAVEfmt ', 8)
header.writeUInt32LE(16, 16)
header.writeUInt16LE(1, 20) // PCM
header.writeUInt16LE(1, 22) // mono
header.writeUInt32LE(RATE, 24)
header.writeUInt32LE(RATE * 2, 28)
header.writeUInt16LE(2, 32)
header.writeUInt16LE(16, 34)
header.write('data', 36)
header.writeUInt32LE(data.length, 40)

mkdirSync(out, { recursive: true })
writeFileSync(join(out, 'rain.wav'), Buffer.concat([header, data]))
