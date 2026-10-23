// Generates the rain loop (AC8.3): `public/audio/rain.mp3`, mono 22.05 kHz, 30 s of steady rain
// that loops without a seam. Synthesised from seeded noise, so it is an original work with no
// third-party license (see _docs/assets.md), and the synthesis is identical on every run.
//
// Run from frontend/: node scripts/generate-rain.mjs
// Needs LAME on the PATH (the committed file was made with LAME 4.0, `lame --version`) and
// ffmpeg is only needed to check the result (see _docs/assets.md). CI does not run this: the
// encoded file is committed.
//
// How the loop stays seamless:
// - The signal is exactly periodic with period LOOP seconds: the noise filter runs over the data
//   twice (keeping the second pass), droplet tails wrap around, the swell uses whole cycles.
// - MP3 decoders add or strip a little silence at each end (encoder delay and padding, which
//   differs between browsers). So the file holds the loop plus PAD seconds of the periodic
//   signal on each side, and the player loops only [PAD, PAD + LOOP) (`loopStart`/`loopEnd`).
//   Whether or not a decoder strips its delay (up to ~60 ms), that window holds real rain.
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const RATE = 22050
const LOOP = 30 // seconds in one loop
const PAD = 0.1 // seconds of the periodic signal on each side of the loop
const BITRATE = 128 // kbps, constant
const N = RATE * LOOP
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

// Bed: broadband hiss. White noise, a gentle one-pole low-pass (about 9 kHz) to soften the top,
// and a high-pass (about 250 Hz) for no rumble. Run twice, keeping the second pass, so the
// filter state wraps.
const white = Float32Array.from({ length: N }, () => random() * 2 - 1)
const hiss = new Float32Array(N)
{
  const lowpass = 1 - Math.exp((-2 * Math.PI * 9000) / RATE)
  const highpass = 1 - Math.exp((-2 * Math.PI * 250) / RATE)
  const body = 1 - Math.exp((-2 * Math.PI * 1500) / RATE)
  let low = 0
  let mid = 0
  let slow = 0
  for (let round = 0; round < 2; round++) {
    for (let i = 0; i < N; i++) {
      low += lowpass * (white[i] - low)
      mid += body * (low - mid) // adds body below 1.5 kHz so the hiss is not harsh
      const bed = low + 2.5 * mid
      slow += highpass * (bed - slow)
      if (round === 1) hiss[i] = bed - slow
    }
  }
}

// Drops: short decaying tones at random pitches, wrapped around the loop end.
const drops = new Float32Array(N)
const dropCount = LOOP * 60
for (let d = 0; d < dropCount; d++) {
  const start = Math.floor(random() * N)
  const freq = 1500 + random() * 4500
  const amp = (0.1 + random() * random() * 0.9) * 0.5
  const tau = (0.001 + random() * 0.004) * RATE
  const length = Math.floor(tau * 6)
  for (let k = 0; k < length; k++) {
    drops[(start + k) % N] += amp * Math.exp(-k / tau) * Math.sin((2 * Math.PI * freq * k) / RATE)
  }
}

// A slow swell (whole cycles per loop, so it joins up) keeps the hiss from sounding like a tone.
const loop = new Float32Array(N)
let sumSquares = 0
for (let i = 0; i < N; i++) {
  const t = i / N
  const swell = 1 + 0.1 * Math.sin(2 * Math.PI * 3 * t) + 0.06 * Math.sin(2 * Math.PI * 7 * t + 1)
  loop[i] = hiss[i] * swell + drops[i]
  sumSquares += loop[i] * loop[i]
}
// Level: RMS of -23.7 dBFS (about -21.5 LUFS once encoded), checked after encoding with
// `ffmpeg -i rain.mp3 -af ebur128=peak=true -f null -`.
const gain = 10 ** (-23.7 / 20) / Math.sqrt(sumSquares / N)

// The periodic signal over [-PAD, LOOP + PAD).
const pad = Math.round(PAD * RATE)
const total = N + 2 * pad
const data = Buffer.alloc(total * 2)
for (let i = 0; i < total; i++) {
  const sample = Math.max(-1, Math.min(1, loop[(((i - pad) % N) + N) % N] * gain))
  data.writeInt16LE(Math.round(sample * 32767), i * 2)
}
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
const work = mkdtempSync(join(tmpdir(), 'rain-'))
try {
  const wav = join(work, 'rain.wav')
  writeFileSync(wav, Buffer.concat([header, data]))
  execFileSync(
    'lame',
    [
      '--quiet',
      '-q',
      '0',
      '-m',
      'm',
      '--cbr',
      '-b',
      String(BITRATE),
      '--noreplaygain',
      wav,
      join(out, 'rain.mp3'),
    ],
    { stdio: 'inherit' },
  )
} finally {
  rmSync(work, { recursive: true, force: true })
}
