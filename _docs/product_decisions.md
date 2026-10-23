# I Need To Focus — Product Decisions

Status: agreed MVP product scope. The technical plan lives in [tech_stack.md](tech_stack.md).

Production: https://ineedtofoc.us · Dev: https://dev.ineedtofoc.us

## 1. Problem

People who want to do focused work, study, read, meditate, exercise or nap need three things that are usually spread across separate apps: a timer that fits how they work (fixed countdown, Pomodoro, or open-ended), calm background sound that keeps them in the zone, and an honest record of where their focus time actually went. **I Need To Focus** puts all three in one quiet, mobile-friendly app: start a session in a couple of taps, let it run with rain or a YouTube track in the background, and later review your focus history by day, week, month, all time or any custom range, filtered by what you were focusing on.

## 2. Users and platforms

- **Primary user:** an individual who wants to track their own focus time across devices. No teams or sharing in the MVP.
- **MVP platform:** a mobile-first web app that works in desktop and mobile browsers and can be installed to the home screen.
- **Stretch (post-MVP):** native iOS and Android apps.

### Known platform limitations (web MVP)

- Mobile browsers, iOS in particular, may pause timers and sound when the screen locks or the user switches apps. Timers are based on start/end timestamps so the time shown is always correct when the app comes back, but chimes and background audio may not play while the phone is locked. The "Keep screen awake" toggle (F9) mitigates this; reliable locked-screen alerts are a reason for the native stretch goal.
- YouTube's terms require a visible player and forbid extracting audio, and mobile browsers stop YouTube playback in the background. YouTube audio therefore plays through a small visible embedded player and works best on desktop or with the screen on.

## 3. Key user journey

> Sign in → choose a mode, tag and (optionally) a goal and background sound → start → focus → session ends → the session appears in History and in the totals.

This journey is the one that must never silently fail: **a finished session must never be lost.**

## 4. MVP feature specification

Each feature lists acceptance criteria (AC) that define "done".

### F1. Accounts

Users sign up and sign in with email and password; their sessions and settings are stored on the server and available on any device.

- AC1.1 A user can sign up with an email and a password of 8 to 128 characters; duplicate emails (matched regardless of case and surrounding spaces) are rejected with a clear message.
- AC1.2 A user can sign in and sign out; a signed-out user cannot see or change any data.
- AC1.3 A user only ever sees their own sessions and settings.
- AC1.4 Signing in on a second device shows the same history and settings.
- AC1.5 Passwords are never displayed, logged, or stored in plain text.

### F2. Countdown timer

- AC2.1 The user can pick a duration from 1 to 240 whole minutes; values outside that range cannot be started.
- AC2.2 The timer shows remaining time and counts down to 00:00.
- AC2.3 At 00:00 the end bell plays and the session is saved with status **Completed**.
- AC2.4 The user can pause and resume; paused time does not count toward focus time.
- AC2.5 The user can stop early; the session is saved with status **Ended early** and its actual focus time (see F6).

### F3. Pomodoro timer

- AC3.1 Defaults: 25 min focus, 5 min short break, 4 focus blocks, long break off.
- AC3.2 Configurable: focus 5–90 min, short break 1–30 min, focus blocks 1–8, optional long break 5–60 min (default 15) that replaces the short break after every 4th focus block. The user's last-used configuration is remembered.
- AC3.3 Phases advance automatically; the end bell plays at every automatic phase change (not when the user skips a break or stops early). There is no break after the final focus block.
- AC3.4 The screen always shows the current phase (Focus / Break / Long break), its remaining time, and progress (e.g. "Block 2 of 4").
- AC3.5 The user can pause/resume at any point and skip the current break.
- AC3.6 The whole Pomodoro is saved as **one** history entry. Only focus time counts toward totals; the entry also records how many focus blocks were completed.
- AC3.7 Stopping before the last block saves the entry as **Ended early** with the focus time accumulated so far.

### F4. Unlimited timer

- AC4.1 The timer counts up from 00:00 until the user stops it.
- AC4.2 Optional reminder interval: Off (default), 15, 30, 45, 60, 90 or 120 min. At each interval a gentle chime (not a voice) plays.
- AC4.3 Pause/resume is supported; reminders are based on focus time, not wall-clock time.
- AC4.4 Stopping saves the session as **Completed**.
- AC4.5 The timer stops itself at 12 hours of focus time (paused time excluded) and saves the session as **Completed**, so a forgotten timer cannot run indefinitely.

### F5. Sounds

- AC5.1 Two distinct, gentle sounds: an interval **chime** (F4 reminders) and an end **bell** (phase/session end). No voice.
- AC5.2 Separate volume controls for alert sounds and for background audio.
- AC5.3 Settings let the user preview each sound.

### F6. Session rules (all modes)

- AC6.1 Only one session can be active at a time.
- AC6.2 Sessions with less than 1 minute of focus time are not saved; the user is told why.
- AC6.3 Every saved session records: mode, tag, optional goal, start time, end time, focus time, paused time, status (Completed / Ended early), and the mode settings used.
- AC6.4 An active session survives a page reload or the app being closed and reopened on the same device, and shows the correct time on return.
- AC6.5 If a countdown or Pomodoro reaches its end while the app is closed, it is recorded as Completed at its scheduled end time.

### F7. Tags and goal

- AC7.1 Every session has exactly one tag from: **Work, Study, Nap, Read, Meditation, Exercise**.
- AC7.2 The tag defaults to the last one used (Work for a new user).
- AC7.3 The user can optionally enter a one-line goal ("What are you focusing on?"), up to 120 characters, shown on the timer screen and in history. Line breaks in a goal are replaced by a single space.

### F8. Background audio

- AC8.1 Before or during a session the user picks one source: **None**, **Rain** or **YouTube**.
- AC8.2 Audio starts with the session, pauses when the timer pauses, keeps playing through Pomodoro breaks, and stops when the session ends.
- AC8.3 **Rain:** a royalty-free (CC0) recording that loops seamlessly (no audible gap), works fully offline, and is small (target ≤ 600 KB).
- AC8.4 **YouTube:** the user pastes a YouTube link; the video plays in a small, visible embedded player and loops for as long as the session runs.
- AC8.5 Invalid links, unavailable videos and videos that do not allow embedding show a clear message; the session itself is unaffected.
- AC8.6 The 5 most recent YouTube links are remembered per user for one-tap reuse.
- AC8.7 When offline, YouTube is unavailable and the app suggests Rain.

### F9. Timer screen

- AC9.1 A dark, distraction-free full-screen view showing the time, mode/phase, tag, goal and audio controls.
- AC9.2 "Keep screen awake" toggle that keeps the screen on during a session where the device supports it.
- AC9.3 Layout works on phone screens (from 360 px wide) as well as desktop.

### F10. History

- AC10.1 Views: **Day, Week, Month, All time, Custom range** (start and end date, inclusive). Day/Week/Month views have previous/next navigation.
- AC10.2 Tag filter: select one or more tags; a session is shown if its tag is any of the selected ones. Default: all tags.
- AC10.3 Each view shows total focus time, number of sessions, a breakdown of focus time by tag, a bar chart (by day for Week, Month and Custom ranges up to ~2 months; by month for All time and longer ranges), and the list of sessions, newest first.
- AC10.4 Each session in the list shows date, start time, mode, tag, focus time, status and goal.
- AC10.5 Days and weeks follow the user's local time zone; a session that crosses midnight counts toward the day it started.
- AC10.6 Weeks start on **Sunday** by default; configurable in Settings (F12).
- AC10.7 Totals and filters exclude archived sessions.
- AC10.8 A clear empty state when a view has no sessions.
- AC10.9 Sessions that are saved but not yet synced (F13) appear in history with a "not synced yet" indicator. A session the server rejected stays on the device with a separate "Couldn't sync" indicator.

### F11. Editing and archiving sessions

Sessions are archived instead of deleted, so nothing is lost by accident.

- AC11.1 For an active (non-archived) session, the user can change its tag and goal. Times and durations cannot be edited in the MVP.
- AC11.2 The user can archive a session; it disappears from history views and totals immediately, with an "Undo" option.
- AC11.3 An **Archive** view lists all archived sessions.
- AC11.4 Archived sessions cannot be modified; they can only be **restored** or **deleted**.
- AC11.5 Restoring returns the session to history exactly as it was.
- AC11.6 "Delete all archived sessions" permanently deletes every archived session after a confirmation dialog that states how many will be deleted. This cannot be undone.
- AC11.7 Non-archived sessions can never be permanently deleted directly.

### F12. Settings (per user, synced across devices)

- AC12.1 Week start day (default Sunday).
- AC12.2 Alert sound volume and background audio volume, each 0–100 (defaults: alert 80, background 50).
- AC12.3 Keep screen awake default (off for a new user).
- AC12.4 Default unlimited-timer reminder interval.
- AC12.5 Last-used Pomodoro configuration and tag are remembered (no stored tag means Work, per AC7.2).

### F13. Offline use and sync

- AC13.1 Once signed in, all three timers, Rain, and sound alerts work without a connection.
- AC13.2 A finished session is saved on the device immediately, before any network call.
- AC13.3 Unsynced sessions and changes are sent automatically when the connection returns.
- AC13.4 Retrying a sync never creates duplicate sessions.
- AC13.5 A finished session is never lost due to a network error or a server error.

## 5. Non-functional requirements (product-level)

- **Reliability:** saving a finished session and loading history are the critical paths (see §3).
- **Privacy:** session goals and email addresses are personal data; they must not appear in analytics, logs or monitoring.
- **Accessibility:** controls are usable with keyboard and screen readers; time is readable at a glance; respects reduced-motion settings.
- **Calm by design:** no streak shaming, no pop-ups during a session, no ads.

## 6. Out of scope for the MVP (post-MVP backlog)

- Export history as CSV
- Daily focus goal and streaks
- Custom tags with colors
- Manually adding a session (forgot to start the timer)
- Editing session times/durations
- Notifications when a session ends (including while the app is in the background)
- Password reset by email, Google sign-in, guest mode
- Picking up an active session on a different device
- Multiple tags per session
- Account deletion and data export
- **Stretch:** native iOS and Android apps

## 7. Prioritization

If time runs short, cut in this order, first cut first: YouTube background audio (F8.4–F8.7) → Pomodoro long break → custom history range. Everything else in §4 is the core MVP.

## 8. Decision log

Product decisions made after this document was agreed. The product manager agent records every decision it makes within agreed scope here; decisions beyond agreed scope are Yacine's (see [process.md — Human gates](process.md#human-gates)).

| Date | Question | Decision | Why | Issue |
|---|---|---|---|---|
| 2026-10-20 | Who gives final acceptance, and when is Yacine involved? | The product manager agent accepts every delivered issue; Yacine is involved only at the human gates | Lets the team work through the backlog without per-task approvals | #48 |
| 2026-10-21 | Where do non-deploy secrets live (Claude API key, read-only Grafana token, Grafana Cloud OTLP token)? | Claude API key and read-only Grafana token in a GitHub `oncall` environment (no reviewer, `main` only); OTLP token only in the server's per-environment `.env` files | Keeps "no credential at repo level" true; on-call can act at any hour without holding deploy keys; the collector is the only OTLP consumer | #51 |
| 2026-10-21 | What are the default settings for a new user (F12)? | Alert volume 80, background audio volume 50 (both 0–100), Keep screen awake off; week start stays Sunday (AC10.6) | Alerts must be clearly audible over background audio, which should sit under them; keep-awake costs battery, so it is opt-in and the user turns it on in Settings or on the timer screen (AC9.2) | #6 |
| 2026-10-21 | What does an empty last-used tag mean in settings? | No stored last tag (`last_tag` NULL) means Work; the API and the app treat it as Work | Matches AC7.2 (Work for a new user): a new user has no last-used tag yet | #6 |
| 2026-10-21 | What are the on-call secrets called? | `ANTHROPIC_API_KEY` (Claude API key used only by the on-call workflow) and `GRAFANA_READONLY_TOKEN` (read-only Grafana token), both secrets of the GitHub `oncall` environment | One fixed name per secret so Yacine's setup steps, the workflow and the docs agree | #35, #32 |
| 2026-10-21 | Who runs migrations on deploy, now that the schema merged before the compose app service? | #4 owns running `alembic upgrade head` before the app starts (a failed migration fails startup); #6 keeps backward compatibility | The app service lives in #4; #6 had nothing to wire it into | #6, #4 |
| 2026-10-23 | Is the unlimited timer's 12 h auto-stop (AC4.5) measured on focus time or wall-clock time? | Focus time (paused time excluded); a paused timer never auto-stops; saved as Completed with 12 h of focus | Same clock as the reminders (AC4.3) and the display; paused time never counts (AC2.4), so a paused timer cannot inflate history | #13 |
| 2026-10-23 | How does the long break (AC3.2) interact with the short break and the final block? | It replaces the short break after blocks 4 and 8; no break after the final block (AC3.3), so with 1–4 blocks it never occurs | "After every 4th block" plus "no break after the final block" | #13 |
| 2026-10-23 | Does the end bell play when the user skips a break or stops early? | No. The bell plays only on automatic transitions (a phase reaching zero, session completion, the 12 h auto-stop); a skip is still recorded as a phase change | The bell tells someone who isn't watching the screen; a user who just pressed the button doesn't need it | #13, #16 |
| 2026-10-23 | What does Pomodoro progress (AC3.4) show during a break? | The block the break follows ("Block 2 of 4" during the break after block 2) | The block count stays stable and readable; the phase label already says Break | #13 |
| 2026-10-23 | Does signing up also sign the user in? | Yes: a successful sign-up starts a session straight away | One step fewer before the first focus session | #8 |
| 2026-10-23 | How are emails and passwords validated (AC1.1)? | Emails are trimmed and compared without regard to case (`Bob@X.com` = `bob@x.com`). Passwords are 8 to 128 characters; a password outside that range is refused with a message naming the limit | AC1.1 sets the minimum. The 128 maximum bounds hashing cost. Ignoring case stops duplicate accounts that differ only in case | #8 |
| 2026-10-23 | How long does a user stay signed in? | 30 days from sign-in, or until they sign out | Phone users shouldn't have to sign in again often; sign-out revokes the session at once | #8 |
| 2026-10-23 | What happens after repeated failed sign-ins? | After 5 failed attempts for one email from one client (or 20 from one client) within 15 minutes, sign-in is refused for 15 minutes, even with the correct password. Sessions that are already signed in are not affected. For the MVP a server restart clears the counters | Basic brute-force protection (#8 AC). Refusing the correct password during the lockout is what makes it work. Keeping counters in memory is enough for one app process; hardening is in #77 | #8, #77 |
| 2026-10-23 | Which issues own syncing the last-used Pomodoro configuration and tag (AC12.5)? | #12 validates and stores `pomodoro_config` (against AC3.2) and `last_tag` (NULL means Work) in the Settings API; #22 backs the setup screen's `PreferencesStore` (#14) with that API and keeps the device copy as the offline cache | The columns already exist (#6) and #12 already lists them; the setup screen (#14) stores them on the device behind an interface so the Settings screen work can plug in the API without touching it | #12, #22, #14 |
| 2026-10-23 | When a sync batch contains a session the server rejects, what happens to the batch and to that session? | Results are per item (`created` / `existing` / `rejected` with a reason); valid items are saved even when others are rejected; only an invalid request envelope (not signed in, not a `sessions` list, 0 or more than 100 items) fails the whole batch. A rejected session stays on the device with a "Couldn't sync" indicator, isn't retried automatically and never blocks later syncs | One bad session must never block or lose the others (AC13.3, AC13.5) | #10, #19 |
| 2026-10-23 | What does a repeat save of an already-saved session do? | Returns the stored copy and changes nothing, even after the session was edited or archived; offline tag/goal edits sync as separate edits, never as a re-save | A retry must never duplicate (AC13.4) or undo a later edit or archive | #10 |
| 2026-10-23 | What is the maximum focus time of a saved session? | 12 h (43 200 s, inclusive) in every mode | The most any mode can produce: countdown 240 min (AC2.1), Pomodoro 90 min × 8 blocks (AC3.2), unlimited auto-stop (AC4.5) | #10 |
| 2026-10-23 | Which characters count as line breaks in a goal (AC7.3)? | Every `str.splitlines()` boundary: CR, LF, CRLF, VT, FF, U+001C–U+001E, U+0085, U+2028, U+2029. Each run becomes one space, then the goal is trimmed before the 120-character check | AC7.3 promises one line; other line separators would still render as a new line | #10 |
| 2026-10-23 | Is the Archive list (AC11.3) paginated? | No, not in the MVP; most recently archived first | AC11.3 lists all archived sessions, and "Delete all archived" (AC11.6) keeps the list short | #10 |
| 2026-10-23 | Which YouTube links are accepted (AC8.4–AC8.6)? | `http` or `https` only, on hosts `youtube.com`, `www.youtube.com`, `m.youtube.com`, `music.youtube.com`, `youtu.be`, `youtube-nocookie.com` and `www.youtube-nocookie.com`, up to 2048 characters; the path is never checked, so shorts, playlist, live and embed links work. The API rejects a link with no scheme (422). The client (#18) adds `https://` to a link pasted without a scheme before checking and saving it, and shows the AC8.5 message only when the link still fails | Covers every way people share YouTube links while keeping look-alike hosts out; a missing scheme is a paste habit, not an invalid link, so the client fixes it and the API stays strict. The hardening in #95 narrows this set without changing it | #12, #18 |
| 2026-10-23 | What tag values does the API use (AC7.1)? | Lowercase identifiers `work`, `study`, `nap`, `read`, `meditation`, `exercise` for `last_tag` and session tags; a display name such as `Work` gets 422. The display names in AC7.1 are a client concern only, and the client shows null as Work (AC7.2) | One stable spelling in the API and the database; labels can change in the app without a migration | #12 |
