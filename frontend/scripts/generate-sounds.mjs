// Generates the two alert sounds (AC5.1) as small mono 16-bit WAV files.
// Both are synthesised here from sine partials, so they are original works with no third-party
// license: see _docs/assets.md. Run from frontend/: node scripts/generate-sounds.mjs
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const RATE = 16000
const out = join(dirname(fileURLToPath(import.meta.url)), '..', 'public', 'sounds')

/** partials: [frequencyHz, amplitude, decaySeconds]; start is the note's offset in seconds. */
function render(seconds, notes) {
  const samples = new Float32Array(Math.floor(seconds * RATE))
  for (const { start, partials } of notes) {
    for (const [freq, amp, decay] of partials) {
      for (let i = Math.floor(start * RATE); i < samples.length; i++) {
        const t = i / RATE - start
        const attack = Math.min(1, t / 0.008)
        samples[i] += amp * attack * Math.exp(-t / decay) * Math.sin(2 * Math.PI * freq * t)
      }
    }
  }
  // Short fade-out so the file never ends on a click, then normalise to a gentle peak.
  const fade = Math.floor(0.05 * RATE)
  for (let i = 0; i < fade; i++) samples[samples.length - 1 - i] *= i / fade
  let peak = 0
  for (const s of samples) peak = Math.max(peak, Math.abs(s))
  return samples.map((s) => (s / peak) * 0.6)
}

function wav(samples) {
  const data = Buffer.alloc(samples.length * 2)
  samples.forEach((s, i) => data.writeInt16LE(Math.round(s * 32767), i * 2))
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
  return Buffer.concat([header, data])
}

// Bell: one soft, low struck tone with slightly inharmonic overtones, ringing for about 2 s.
const bell = render(2.2, [
  {
    start: 0,
    partials: [
      [392, 1, 0.7],
      [392 * 2.0, 0.5, 0.5],
      [392 * 2.76, 0.25, 0.3],
      [392 * 5.4, 0.08, 0.15],
    ],
  },
])

// Chime: two quick, light, high notes (a rising third), clearly unlike the bell.
const chime = render(1.1, [
  {
    start: 0,
    partials: [
      [1046.5, 1, 0.22],
      [2093, 0.15, 0.1],
    ],
  },
  {
    start: 0.16,
    partials: [
      [1318.5, 1, 0.3],
      [2637, 0.15, 0.1],
    ],
  },
])

mkdirSync(out, { recursive: true })
writeFileSync(join(out, 'bell.wav'), wav(bell))
writeFileSync(join(out, 'chime.wav'), wav(chime))
