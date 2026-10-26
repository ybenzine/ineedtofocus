// Makes the two alert sounds (F5, AC5.1) from CC0 recordings: `public/sounds/chime.mp3` (interval
// reminder) and `public/sounds/bell.mp3` (end bell). Replaces the earlier synthesised sines (#254).
// The originals are NOT committed (size); this script and _docs/assets.md are the record.
//
// Sources (Freesound, both CC0 1.0; download the original WAV, a free account is needed):
//   chime: "Bright Tibetan Bell Ding (B)" by steaq, https://freesound.org/people/steaq/sounds/346328/
//          (346328__steaq__bright-tibetan-bell-ding-b-note-cleaner.wav, 15.5 s, 44.1 kHz/16-bit stereo)
//   bell:  "Single chime" by LloydEvans09, https://freesound.org/people/LloydEvans09/sounds/185822/
//          (185822__lloydevans09__single-chime.wav, 7.7 s, 96 kHz/24-bit stereo)
//
// Run from frontend/:
//   node scripts/generate-sounds.mjs <chime-original.wav> <bell-original.wav>
// Needs ffmpeg with libmp3lame on the PATH. CI does not run this: the encoded files are committed.
//
// Processing, per file (the same ffmpeg gives the same bytes):
//   1. Mix to mono (equal-weight average of the channels) and resample to 44.1 kHz.
//   2. Keep the first CHIME_SECONDS / BELL_SECONDS (the strike is at the very start).
//   3. Fade out over the last CHIME_FADE / BELL_FADE seconds with a quarter-sine curve, so it dies
//      away naturally and never ends on a click.
//   4. Gain so the integrated loudness (EBU R128, measured on the trimmed, faded signal) is
//      TARGET_LUFS. The gain comes from a first measuring pass; the encoding pass applies it,
//      then a peak limiter at PEAK_LIMIT (a no-op unless the strike would clip).
//   5. Encode MP3, mono, 44.1 kHz, 96 kbps CBR, with ffmpeg's bit-exact flags (no encoder tag).
import { execFileSync, spawnSync } from 'node:child_process'
import { mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const CHIME_SECONDS = 4.5
const CHIME_FADE = 2.5
const BELL_SECONDS = 2.8
const BELL_FADE = 1.6
const TARGET_LUFS = -16 // matched for both; the rain loop sits at -21.9 LUFS
const PEAK_LIMIT = -1.5 // dBFS
const RATE = 44100
const BITRATE = '96k'

const out = join(dirname(fileURLToPath(import.meta.url)), '..', 'public', 'sounds')

const [chimeSrc, bellSrc] = process.argv.slice(2)
if (!chimeSrc || !bellSrc) {
  console.error('usage: node scripts/generate-sounds.mjs <chime-original.wav> <bell-original.wav>')
  process.exit(1)
}

function shape(seconds, fade) {
  return [
    'aformat=channel_layouts=mono', // equal-weight downmix
    `aresample=${RATE}`,
    `atrim=0:${seconds}`,
    'asetpts=PTS-STARTPTS',
    `afade=t=out:st=${seconds - fade}:d=${fade}:curve=qsin`,
  ].join(',')
}

/** Integrated loudness (LUFS) of `src` after `filter`, from ffmpeg's ebur128 summary. */
function measure(src, filter) {
  const args = [
    '-hide_banner',
    '-nostats',
    '-i',
    src,
    '-af',
    `${filter},ebur128`,
    '-f',
    'null',
    '-',
  ]
  const r = spawnSync('ffmpeg', args, { encoding: 'utf8' })
  if (r.status !== 0) throw new Error(r.stderr)
  const found = [...r.stderr.matchAll(/^\s*I:\s+(-?[\d.]+) LUFS/gm)]
  return Number(found[found.length - 1][1])
}

function make(src, name, seconds, fade) {
  const shaped = shape(seconds, fade)
  const loudness = measure(src, shaped)
  const gain = Math.round((TARGET_LUFS - loudness) * 100) / 100
  const limiter = `alimiter=limit=${10 ** (PEAK_LIMIT / 20)}:level=disabled:attack=1:release=50`
  const args = ['-hide_banner', '-loglevel', 'error', '-y', '-i', src]
  args.push('-af', `${shaped},volume=${gain}dB,${limiter}`)
  args.push('-ac', '1', '-ar', String(RATE), '-c:a', 'libmp3lame', '-b:a', BITRATE)
  args.push('-write_xing', '0', '-fflags', '+bitexact', '-flags:a', '+bitexact', join(out, name))
  execFileSync('ffmpeg', args)
  console.log(`${name}: source ${loudness} LUFS, gain ${gain} dB`)
}

mkdirSync(out, { recursive: true })
make(chimeSrc, 'chime.mp3', CHIME_SECONDS, CHIME_FADE)
make(bellSrc, 'bell.mp3', BELL_SECONDS, BELL_FADE)
