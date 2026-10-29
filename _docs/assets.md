# Assets

Every third-party or generated asset shipped with the app, with its source and license.

## Alert sounds (F5, AC5.1)

| File                               | Used for                                                       | Length / size | Format                       |
| ---------------------------------- | -------------------------------------------------------------- | ------------- | ---------------------------- |
| `frontend/public/sounds/chime.mp3` | Interval chime (unlimited-timer reminders)                     | 4.55 s, 55 KB | MP3, mono, 44.1 kHz, 96 kbps |
| `frontend/public/sounds/bell.mp3`  | End bell (automatic phase change, session end, 12 h auto-stop) | 2.85 s, 34 KB | MP3, mono, 44.1 kHz, 96 kbps |

Both are CC0 recordings from Freesound that Yacine chose (#254). CC0 needs no attribution; they are credited here anyway. The originals are not committed.

| Shipped file | Title and author                                                                                       | Freesound URL                                            | License | Original                            |
| ------------ | ------------------------------------------------------------------------------------------------------ | -------------------------------------------------------- | ------- | ----------------------------------- |
| `chime.mp3`  | "Bright Tibetan Bell Ding (B)" by steaq (`346328__steaq__bright-tibetan-bell-ding-b-note-cleaner.wav`) | https://freesound.org/people/steaq/sounds/346328/        | CC0 1.0 | WAV, 44.1 kHz/16-bit stereo, 15.5 s |
| `bell.mp3`   | "Single chime" by LloydEvans09 (`185822__lloydevans09__single-chime.wav`)                              | https://freesound.org/people/LloydEvans09/sounds/185822/ | CC0 1.0 | WAV, 96 kHz/24-bit stereo, 7.7 s    |

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
- **Listening check:** Yacine listened on dev on 2026-10-26, on a laptop and on an iPhone (Safari
  and Chrome): OK, no trim changes (#254). On an iPhone the sounds are silent while the phone is in
  silent mode, by design ([Decision log](product_decisions.md#8-decision-log), 2026-10-23, "Do
  alerts follow the iOS silent switch?", #16, #17).

They live in `public/` so the service worker (#19) can precache `sounds/chime.mp3` and
`sounds/bell.mp3`; the app loads them from `${import.meta.env.BASE_URL}sounds/…`. The Settings
previews (AC5.3) play the same files.

## Rain loop (F8, AC8.3)

| File                             | Used for                    | Format                                                  | Length / size                                |
| -------------------------------- | --------------------------- | ------------------------------------------------------- | -------------------------------------------- |
| `frontend/public/audio/rain.mp3` | Background rain (AC8.1-8.2) | MP3, mono, 44.1 kHz, VBR (LAME `-q:a 6`, about 63 kbps) | 56.2 s (56 s loop + 0.1 s each side), 490 KB |

- **Source and license:** Yacine Benzine's own field recording of light rain, provided on #135
  (2026-10-29) as `light_rain.wav` (48 kHz, 16-bit stereo, exactly 60 s, 11.5 MB). It is owned by the
  project's author and product owner, so no third-party license or attribution applies. The WAV is
  not committed; only the encoded MP3 ships. This replaces the generated loop of #17
  (`generate-rain.mjs`, removed) and the Freesound/Commons candidates listed on #135, which Yacine
  set aside in favour of his own recording.
- **Processing:** `frontend/scripts/make-rain.mjs`, which holds the exact steps
  (`node scripts/make-rain.mjs <light_rain.wav>` from `frontend/`; needs ffmpeg with libmp3lame, and
  CI does not run it). In order: (1) **mono** (channels averaged) at 44.1 kHz; (2) **loop by
  crossfade**: the last 4 s fade out (equal-power, quarter sine) under the first 4 s fading in, which
  gives a 56 s loop whose end runs into its start; (3) **padding**: 0.1 s of the periodic signal on
  each side; (4) **loudness**: +19.5 dB (the recording is -36 LUFS in stereo, about -41 LUFS as mono),
  then a look-ahead limiter at -2 dBFS (5 ms attack, 80 ms release); (5) **encode** as VBR MP3.
- **Measured on the shipped MP3** (`ffmpeg -i rain.mp3 -af ebur128=peak=true -f null -`): integrated
  loudness **-22.5 LUFS** (range 2.5 LU), true peak **-1.2 dBFS**, sample peak -1.7 dBFS, **44.1 kHz**,
  **489,888 bytes** (limit 600,000), 56.2 s. That sits below the alerts at background volume 50. The
  recording's peaks are 20 dB or more above its average, so the limiter takes up to about 11 dB off
  the rare loudest drops to reach this level.
- **Spectrum:** energy up to 8 kHz and beyond; about 18 dB below the total level above 8 kHz and
  10 dB below it above 4 kHz (`ffmpeg -af highpass=f=8000,astats`). Natural rain is darker than the
  old synthetic hiss, so the test's high-frequency check was lowered (see the test comment).
- **Seamless loop:** the crossfade makes the loop periodic, and MP3 decoders add or strip a little
  silence at each end and browsers differ, so the player loops only `[0.1 s, 56.1 s)` with
  `loopStart`/`loopEnd` (`RAIN_LOOP_START`, `RAIN_LOOP_END` in `src/sounds/rain.ts`). Tests decode the
  MP3 and check that no silent run longer than 5 ms sits at either end of the looped region, and
  that the wrap is no bigger a step than the rest, with and without the decoder's delay stripped.
- **Offline:** it lives in `public/audio/`, so the service worker (#19) precaches it; the app loads
  it from `${import.meta.env.BASE_URL}audio/rain.mp3` and plays it through a looping Web Audio
  `AudioBufferSourceNode`.
- **Listening check:** pending Yacine's listen on the PR (the agent cannot listen; the numbers above
  and the seam tests are what was checked).

## Typeface (#213)

| File                                                                | Used for                                                   | Source                                                                      | License                   |
| ------------------------------------------------------------------- | ---------------------------------------------------------- | --------------------------------------------------------------------------- | ------------------------- |
| `@fontsource-variable/inter` (npm), `inter-latin-wght-normal.woff2` | The app's text (Inter, 400-700, tabular figures for times) | [Inter](https://rsms.me/inter/) by Rasmus Andersson, packaged by Fontsource | SIL Open Font License 1.1 |

`frontend/src/index.css` loads only the Latin subset through its own `@font-face`; the service worker precaches the `.woff2`. Other scripts fall back to `system-ui`.

## YouTube icon (#326)

| Where                                  | Used for                                                                            | Source                                                               |
| -------------------------------------- | ----------------------------------------------------------------------------------- | -------------------------------------------------------------------- |
| `frontend/src/sounds/YoutubeLabel.tsx` | The small icon before a YouTube video or playlist title (recent links, now playing) | Hand-drawn inline SVG of YouTube's play-button mark; no file shipped |

- **What it is:** a rounded red rectangle (28 x 20 viewBox, shown at 16 x 12 px) with a white right-pointing triangle, YouTube's play-button mark in its own colours, `#FF0000` and `#FFFFFF`. The colours are fixed brand colours, not theme tokens, so it looks the same in both themes (the colour-literal test in `colors.test.ts` is satisfied by the named colours `red` and `white`, which are those two values).
- **Use:** as [YouTube's brand guidelines](https://www.youtube.com/howyoutubeworks/resources/brand-resources/) allow for referring to YouTube content: the mark is unaltered apart from scale, it does not stand for the app's own brand and it is used only next to YouTube content (a link that plays in YouTube's own embedded player). It is `aria-hidden`; the text next to it carries the meaning.
- **Source:** drawn from the published shape of the mark (rounded rectangle, centred white play triangle), not copied from a file, so there is no third-party file or licence to carry. If YouTube's brand resources change, replace the two shapes in `YoutubeIcon`.
