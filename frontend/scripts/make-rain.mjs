// Builds the rain loop (AC8.3, #135): `public/audio/rain.mp3` from Yacine's own recording of light
// rain (`light_rain.wav`: 48 kHz, 16-bit stereo, 60 s). The WAV is NOT committed (it is 11.5 MB);
// only the encoded MP3 ships. Supersedes the generated loop (`generate-rain.mjs`, removed).
//
// Run from frontend/: node scripts/make-rain.mjs <path/to/light_rain.wav>
// Needs ffmpeg (with libmp3lame) on the PATH. CI does not run this: the encoded file is committed.
//
// Steps:
// 1. Mono: the two channels averaged (22.05 kHz or better stays; we keep 44.1 kHz).
// 2. Seamless loop by crossfade: the last FADE seconds of the recording fade out (equal power,
//    quarter sine) while the first FADE seconds fade in over them, so the loop is
//    (60 - FADE) s long and its end flows into its start with no step and no level dip.
// 3. Padding: MP3 decoders add or strip a little silence at each end (encoder delay and padding,
//    which differs between browsers). The file holds PAD seconds of the periodic signal on each
//    side (the loop's last PAD seconds first, its first PAD seconds last) and the player loops
//    only [PAD, PAD + loop) (`RAIN_LOOP_START`/`RAIN_LOOP_END` in src/sounds/rain.ts).
// 4. Loudness: the recording is quiet (-36 LUFS), so it gets GAIN dB (the mono mix is about 5 dB quieter than the stereo reading), then a soft look-ahead
//    limiter holds peaks at -2 dBFS (below the -1 dBFS bar, with room for the MP3 encoder).
//    The measured result is in _docs/assets.md.
// 5. Encode: MP3, mono, 44.1 kHz, VBR (libmp3lame -q:a QUALITY), under 600 KB.
import { execFileSync } from 'node:child_process'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const FADE = 4 // seconds of crossfade; the loop is 60 - FADE long
const PAD = 0.1 // seconds of the periodic signal on each side of the loop
const GAIN = Number(process.env.RAIN_GAIN ?? 19.5) // dB
const PEAK = 0.8 // linear, about -2 dBFS
const QUALITY = 6 // libmp3lame VBR quality (0 best, 9 smallest)
const RATE = 44100

const input = process.argv[2]
if (!input) {
  console.error('usage: node scripts/make-rain.mjs <light_rain.wav>')
  process.exit(1)
}
const out = join(dirname(fileURLToPath(import.meta.url)), '..', 'public', 'audio', 'rain.mp3')
const total = Number(
  execFileSync('ffprobe', [
    '-v',
    'error',
    '-show_entries',
    'format=duration',
    '-of',
    'csv=p=0',
    resolve(input),
  ])
    .toString()
    .trim(),
)
const loop = total - FADE

const filter = [
  `[0:a]pan=mono|c0=0.5*c0+0.5*c1,aresample=${RATE},asplit=3[a][b][c]`,
  // head: the recording's first FADE s fading in, plus its last FADE s fading out
  `[a]atrim=0:${FADE},asetpts=PTS-STARTPTS,afade=t=in:d=${FADE}:curve=qsin[head_in]`,
  `[b]atrim=${loop}:${total},asetpts=PTS-STARTPTS,afade=t=out:d=${FADE}:curve=qsin[head_out]`,
  `[head_in][head_out]amix=inputs=2:normalize=0:duration=longest[head]`,
  // body: the rest, from FADE s up to the loop's end
  `[c]atrim=${FADE}:${loop},asetpts=PTS-STARTPTS[body]`,
  `[head][body]concat=n=2:v=0:a=1[loop]`,
  `[loop]asplit=3[l1][l2][l3]`,
  `[l1]atrim=${loop - PAD}:${loop},asetpts=PTS-STARTPTS[pre]`,
  `[l3]atrim=0:${PAD},asetpts=PTS-STARTPTS[post]`,
  `[pre][l2][post]concat=n=3:v=0:a=1,volume=${GAIN}dB,alimiter=limit=${PEAK}:attack=5:release=80:level=disabled[out]`,
].join(';')

execFileSync(
  'ffmpeg',
  [
    '-y',
    '-v',
    'error',
    '-i',
    resolve(input),
    '-filter_complex',
    filter,
    '-map',
    '[out]',
    '-ac',
    '1',
    '-c:a',
    'libmp3lame',
    '-q:a',
    String(QUALITY),
    out,
  ],
  { stdio: 'inherit' },
)
console.log(
  `wrote ${out} (loop ${loop} s, PAD ${PAD} s: RAIN_LOOP_START=${PAD}, RAIN_LOOP_END=${PAD + loop})`,
)
