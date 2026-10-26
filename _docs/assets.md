# Assets

Every third-party or generated asset shipped with the app, with its source and license.

## Alert sounds (F5, AC5.1)

| File                               | Used for                                                       | Length / size | Format                      |
| ---------------------------------- | -------------------------------------------------------------- | ------------- | --------------------------- |
| `frontend/public/sounds/chime.mp3` | Interval chime (unlimited-timer reminders)                     | 4.55 s, 55 KB | MP3, mono, 44.1 kHz, 96 kbps |
| `frontend/public/sounds/bell.mp3`  | End bell (automatic phase change, session end, 12 h auto-stop) | 2.85 s, 34 KB | MP3, mono, 44.1 kHz, 96 kbps |

Both are CC0 recordings from Freesound that Yacine chose (#254). CC0 needs no attribution; they are credited here anyway. The originals are not committed.

| Shipped file | Title and author                                                                                    | Freesound URL                              | License | Original                                    |
| ------------ | --------------------------------------------------------------------------------------------------- | ------------------------------------------ | ------- | ------------------------------------------- |
| `chime.mp3`  | "Bright Tibetan Bell Ding (B)" by steaq (`346328__steaq__bright-tibetan-bell-ding-b-note-cleaner.wav`) | https://freesound.org/people/steaq/sounds/346328/ | CC0 1.0 | WAV, 44.1 kHz/16-bit stereo, 15.5 s |
| `bell.mp3`   | "Single chime" by LloydEvans09 (`185822__lloydevans09__single-chime.wav`)                           | https://freesound.org/people/LloydEvans09/sounds/185822/ | CC0 1.0 | WAV, 96 kHz/24-bit stereo, 7.7 s |

- **Processing** (`frontend/scripts/generate-sounds.mjs`, which holds the source URLs and the exact
  steps; run `node scripts/generate-sounds.mjs <chime-original.wav> <bell-original.wav>` from
  `frontend/`, needs ffmpeg with libmp3lame): downmix to mono, resample to 44.1 kHz, keep the first
  4.5 s (chime) or 2.8 s (bell), fade out over the last 2.5 s (chime) or 1.6 s (bell) with a
  quarter-sine curve, apply the gain that brings the integrated loudness to -16 LUFS, then a peak
  limiter at -1.5 dBFS (not triggered), encode with libmp3lame at 96 kbps CBR using bit-exact flags.
  The same ffmpeg gives the same bytes. CI does not run it; it uses the committed files.
- **Level** (`ffmpeg -i x.mp3 -af ebur128=peak=true -f null -`): chime -16.4 LUFS integrated, true
  peak -4.2 dBFS; bell -16.3 LUFS, true peak -4.1 dBFS. Matched within 0.1 LU, and 5.5 LU above the
  rain loop (-21.9 LUFS), so they sit above it at the default volumes (alert 80, background 50).
- **Listening check:** Yacine's listening check: pending on dev. He may ask for different trim
  lengths (the constants at the top of the script).

They live in `public/` so the service worker (#19) can precache `sounds/chime.mp3` and
`sounds/bell.mp3`; the app loads them from `${import.meta.env.BASE_URL}sounds/…`. The Settings
previews (AC5.3) play the same files.

## Rain loop (F8, AC8.3)

| File                             | Used for                    | Format                             | Length / size                                |
| -------------------------------- | --------------------------- | ---------------------------------- | -------------------------------------------- |
| `frontend/public/audio/rain.mp3` | Background rain (AC8.1-8.2) | MP3, mono, 22.05 kHz, 128 kbps CBR | 30.2 s (30 s loop + 0.1 s each side), 485 KB |

- **Source and license:** an original generated work, owned by the project, made by
  `frontend/scripts/generate-rain.mjs` (seeded noise hiss plus random droplets). It contains no
  third-party material. A generated loop is accepted for the MVP by the product manager's ruling
  on #17; the sound is not a recording.
- **Level:** integrated loudness -21.9 LUFS, true peak -11.7 dBFS (`ffmpeg -i rain.mp3 -af
ebur128=peak=true -f null -`). That sits below the alerts at background volume 50.
- **Spectrum:** broadband hiss up to Nyquist (11 kHz); about 17% of the energy is above 7 kHz and
  31% below 1.5 kHz (`ffmpeg -af highpass=f=7000,astats`).
- **Deterministic:** the synthesis uses a fixed seed; the committed file was produced by
  `node scripts/generate-rain.mjs` (run from `frontend/`) and LAME 4.0
  (`lame -q 0 -m m --cbr -b 128 --noreplaygain`, run by the script). CI does not encode; it uses
  the committed file. Re-running with the same LAME gives the same bytes.
- **Seamless loop:** the signal is exactly periodic over 30 s (the filter wraps around, droplet
  tails wrap, the swell has whole cycles). MP3 decoders add or strip a little silence at each end
  and browsers differ, so the file carries 0.1 s of the periodic signal on each side and the
  player loops only `[0.1 s, 30.1 s)` with `loopStart`/`loopEnd` (`RAIN_LOOP_START`,
  `RAIN_LOOP_END` in `src/sounds/rain.ts`). Tests decode the MP3 and check that no silent run
  longer than 5 ms sits at either end of the looped region, with and without the decoder's delay
  stripped.
- **Offline:** it lives in `public/audio/`, so the service worker (#19) precaches it; the app loads
  it from `${import.meta.env.BASE_URL}audio/rain.mp3` and plays it through a looping Web Audio
  `AudioBufferSourceNode`.
- **Listening check:** Yacine listened on 2026-10-23 and accepted it for the MVP; a real light-rain
  recording replaces it in #135.

## Typeface (#213)

| File                                                                | Used for                                                   | Source                                                                      | License                   |
| ------------------------------------------------------------------- | ---------------------------------------------------------- | --------------------------------------------------------------------------- | ------------------------- |
| `@fontsource-variable/inter` (npm), `inter-latin-wght-normal.woff2` | The app's text (Inter, 400-700, tabular figures for times) | [Inter](https://rsms.me/inter/) by Rasmus Andersson, packaged by Fontsource | SIL Open Font License 1.1 |

`frontend/src/index.css` loads only the Latin subset through its own `@font-face`; the service worker precaches the `.woff2`. Other scripts fall back to `system-ui`.
