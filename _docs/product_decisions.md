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
- AC8.3 **Rain:** a loop that sounds like real rain, either a verified CC0 recording or an original generated work owned by the project; it loops seamlessly (no audible gap), works fully offline, and is small (30–60 s, ≤ 600 KB). Quality bar in the Decision log (#17).
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
| 2026-10-23 | What does sign-out do with local data when a finished session is unsynced or still pending? | Sign-out never silently deletes a finished session. It is offered on the setup, History, Settings and Archive screens, never over the timer or the session summary; it is refused while a timer runs or is paused ("End your session before signing out."); it tries to sync first (#9 retries the `pendingRecord`; #19 waits up to 10 seconds, or skips the wait offline); if anything is still unsynced it shows "N sessions haven't synced and will be deleted from this device." (plus "Some changes to sessions haven't synced either." when edits are queued) with Cancel (the default) and Sign out anyway. It clears an explicit registry of app-owned stores (the `ineedtofocus.*` keys plus clear hooks such as #19's `countUnsynced` / `trySync` / `clear`), never everything, and leaves the service worker's app shell alone | F13 promises a finished session is never lost, AC1.2 says a signed-out user can't see any data, and goals are personal data (§5). On a shared device the user must still be able to sign out, so an informed confirmation beats a hard block; keeping the data to re-sync later is rejected for an explicit sign-out because the user's goals would stay readable on the device | #9, #19 |
| 2026-10-23 | What happens to local data when a remembered user's session ends without sign-out (401 on `/me`) and then a different user signs in? | Local data belongs to a user id. An involuntary sign-out (30-day expiry, revoked elsewhere) shows the sign-in screen but keeps the data under its owner's id; if the same user signs in again, everything carries on, including a running timer and a `pendingRecord`. If a different user signs in, the previous owner's preferences, keep-awake setting and active session are removed before the app renders, and their `pendingRecord` is never handed to `saveRecord` for the new account. With #19, every stored session and queued edit carries its owner's id; another account's unsynced or "Couldn't sync" sessions stay quarantined on the device (not shown, not synced) until that account signs in here again, and an explicit sign-out clears only the signed-out user's data | Data must never be shown to or synced into a different account (AC1.2, AC1.3), while an expiry the user didn't ask for must not lose a finished session (F13) | #9, #19 |
| 2026-10-23 | Where does the AC1.4 end-to-end test (same history and settings on two devices) live? | In #23, which owns the Playwright suite and runs after the history (#20) and settings (#22) screens exist: the same user signed in in two browser contexts, a session finished in A appears in B's history with the same totals, and a week-start change in A shows in B. #9 marks AC1.4 as moved to #23 and is covered meanwhile by a two-device Vitest test; #22 keeps its own pre-fill AC | The screens AC1.4 checks don't exist yet when #9 lands; the Playwright suite is #23's | #9, #23 |
| 2026-10-23 | What does sign-out do while the device is offline? | It signs the user out on this device at once and queues the server logout. After the same checks as online (refused during a running or paused timer; the `pendingRecord` confirmation), it clears the app-owned data and the cached user, sets `ineedtofocus.pendingLogout` (no personal data; the clear registry leaves it in place) and shows "You're signed out on this device. Your account will be fully signed out the next time this device is online." While the marker is set the app never calls `/me` or treats the device as signed in; on start-up, on the `online` event and before any sign-in or sign-up it calls `POST /api/auth/signout`. A 2xx or 401 removes the marker; a network error or 5xx keeps it for the next trigger. An online sign-out that gets a 5xx keeps the user signed in with "Couldn't sign out. Try again." Known limit: until the device is online again the session cookie stays valid on the server (up to its 30-day expiry). While the marker is set, a sign-in or sign-up waits for the queued logout to succeed (see the next row). | Blocking offline sign-out would trap a user on a shared device (AC1.2); a plain local sign-out would leave the HttpOnly cookie, and the next `/me` would quietly sign the next person into the previous account. Logging out before `/me` closes that gap | #9 |
| 2026-10-23 | What happens to sign-in and sign-up while the queued logout keeps failing (offline or 5xx)? | They are held back until the queued logout gets a 2xx or 401, which removes the marker. This replaces the earlier ruling that sign-in "proceeds only after the logout attempt". The message for the 5xx case ("Try again in a moment" rather than "Connect to the internet") is in #108 | Letting sign-in through while the marker is set would make the next flush revoke the new session. It also costs little, because a server that fails logout with a 5xx is probably failing sign-in too | #9, #108 |
| 2026-10-23 | When does a custom history range get day bars, and when month bars (AC10.3)? | Up to 62 days inclusive (`end - start + 1 <= 62`) gets one bar per day; 63 days or more gets one bar per calendar month. No week bars. In a custom range the first and last month bars cover only the days inside the range; their `date` stays the 1st of the month and #20 labels them by month | 62 days is the longest stretch of two consecutive calendar months (Jul–Aug, Dec–Jan), so "~2 months" always gets day bars; AC10.3 promises day or month bars only, and a third bucket size would mean a third chart layout in #20 | #11, #20 |
| 2026-10-23 | What do the 100-year range cap and the All time view return? | The 100-year cap only protects the server. All time runs from the local date of the first session to the local date of the last, with month bars across that span (a user of a few days gets a single month bar, as AC10.3 says). With no sessions, `start` and `end` are null and `buckets` is empty, and #20 shows the AC10.8 empty state | No real user hits the cap; All time follows AC10.3 as written | #11 |
| 2026-10-23 | Does the Day view show a bar chart? | No. The API returns one day bucket so every view has the same response shape, but the Day view shows just the total, session count, tag breakdown and list. Hourly bars aren't in agreed scope | One bar adds nothing to the total | #11, #20 |
| 2026-10-23 | Which time zone names does the history API accept? | `tz` is required on every request and case-sensitive (422 otherwise). It accepts every name in the tz database, including link names that browsers report (`UTC`, `Asia/Calcutta`, `US/Eastern`). The backend ships the `tzdata` package as a runtime dependency so the zone list never depends on the host's file system. The app (#20) sends `Intl.DateTimeFormat().resolvedOptions().timeZone`, or `UTC` if there isn't one | History grouping needs the user's zone (AGENTS.md: convert UTC only for display and grouping); without `tzdata`, an image with no `/usr/share/zoneinfo` would reject every history request | #11, #20 |
| 2026-10-23 | Does each history view accept parameters meant for another view? | No: each view takes only its own parameters, and anything else gets 422. `tag` (repeatable) and `tz` are allowed on every view | The app is the only client and builds every request itself, so a strict 422 catches bugs early | #11 |
| 2026-10-23 | Is the history session list (AC10.3) paginated? | No, not in the MVP: the response returns every non-archived session in the view, newest first. Pagination or a 'load more' cap is new work if real use needs it | At MVP scale even 10 sessions a day for five years is about 18,000 small rows, and Day/Week/Month return a few dozen; matches the Archive ruling | #11, #20 |
| 2026-10-23 | Which start and end times may a saved session have? | `started_at` and `ended_at`, after conversion to UTC, must both fall between `2020-01-01T00:00:00Z` and the server's current time + 24 h, both bounds inclusive. Outside that window `POST /api/sessions` returns 422, and in `POST /api/sessions/sync` the item is `rejected` with the reason the sync uses for an item that fails validation, while the other items in the batch are still saved. On the device that session stays with the "Couldn't sync" indicator (AC10.9, #19), so it is never lost (AC13.5). Not affected: rows already stored (no migration, no backfill), the history query parameters (the custom range keeps its 100-year cap) and editing tag/goal, archive and restore (times can't be edited, AC11.1) | The app didn't exist before 2026, so no real session is older, and a fixed lower bound doesn't drift and is easy to test. The + 24 h upper bound covers device clocks set a few hours fast and a client that sends local time labelled as UTC (offsets reach +14 h); bounding `ended_at` too stops `paused_seconds` putting the end decades after the start. All time is capped at about 82 month bars today (Jan 2020 to Oct 2026, growing by 12 a year) instead of about 120,000 | #98, #11 |
| 2026-10-23 | Where is AC5.3 (sound previews in Settings) placed, given that the Settings screen (#22) isn't built when #16 lands? | #16 delivers the reusable `SoundPreview` component (preview chime, preview bell, alert-volume slider) with tests and closes without waiting for #22. #22 places it in the Settings screen, where its slider is the only alert-volume control, and replaces #16's device-local `AlertVolumeStore` (`ineedtofocus.alertVolume`, default 80) with the Settings API's `alert_volume` (default 80): nothing reads or writes `ineedtofocus.alertVolume` afterwards, and old local values are not migrated | AC5.3 ("Settings let the user preview each sound") is a property of the Settings screen, and #22 already listed it; holding #16 open for #22 would block a finished feature for no product gain. Scope is unchanged: AC5.3 is still delivered in the MVP, by #22 | #16, #22 |
| 2026-10-23 | Is the sign-up limit acceptable for users who share one IPv4 address (office, campus, carrier NAT)? | Yes, for the MVP: they share the 10 sign-ups per client per hour. When it is hit, the sign-up screen shows "Too many attempts." with the wait time, and sign-in isn't affected. If real users report it, raise `SIGNUP_MAX_PER_CLIENT` (a setting, no code change) | Each person signs up once, and an hour is a short wait | #77 |
| 2026-10-23 | Do alerts follow the iOS silent switch? | Yes. The app leaves `navigator.audioSession.type` at its default and never sets it to `'playback'`. The timer stays correct on screen | The silent switch is the user's own choice to keep the phone quiet, and `'playback'` would also stop music playing in other apps. Reliable alerts on a silenced phone are a reason for the native stretch goal (§1) | #16, #17 |
| 2026-10-23 | What happens to a sound that falls due after a reload, before the user has tapped anything? | It is dropped, not played late. The first user gesture unlocks audio for every later sound, and the timer display stays correct | Browsers block audio until the first gesture; a late sound at the wrong moment is worse than none | #16 |
| 2026-10-23 | Must the rain loop (AC8.3) be a recording, and what quality must it meet? | It may be a verified CC0 recording or an original generated loop owned by the project (`_docs/assets.md` names the generator script and says it has no third-party material); "recording" describes how it must sound, not how it is made. Quality bar, all required: sample rate ≥ 22.05 kHz with broadband energy up to at least 8 kHz; mono is fine; 30–60 s and ≤ 600 KB as MP3 (preferred) or AAC in `.m4a`, not Ogg/Opus/Vorbis; no audible gap at the loop point (the player loops only the real audio, excluding encoder padding, with a test that the looped region has no silent run longer than 5 ms at either end); peaks ≤ -1 dBFS, no clipping, integrated loudness about -23 to -20 LUFS; it sounds like steady rain with no tone, hum, short repeating pattern or seam click, confirmed by a listening check written on the PR. If a generated loop fails that check, use a CC0 file from Wikimedia Commons (explicit CC0 or public-domain tag) or BigSoundBank (CC0 stated on the file's page), with URL, author and license in `_docs/assets.md`; not Freesound, Pixabay or any site that doesn't state CC0. If neither works, ask Yacine on #17 | What the user gets is a rain sound that is license-safe, gapless, offline and small; an original work meets the license goal more strongly than a third-party file. The loudness keeps the rain under the alerts (about -19 and -17 LUFS) at background volume 50 | #17 |
| 2026-10-23 | How is a previous owner's countdown or Pomodoro that ended while the app was closed saved? | As Completed at its scheduled end time, under that owner (AC6.5); it stays quarantined until that owner signs in on this device again | Same rule as for the current owner; it must never be lost or filed under another account | #19 |
| 2026-10-23 | What does the sign-out confirmation say when only edits (no sessions) are unsynced? | "Some changes to sessions haven't synced and will be deleted from this device.", with Cancel the default as for sessions | The user must know what an explicit sign-out discards, whether sessions or edits | #19, #9 |
| 2026-10-23 | What happens to a queued tag/goal edit that the server answers with 404 or 422? | It is kept on the device, marked "Couldn't sync" and not retried automatically; a 409 still drops it (archive, restore and delete-all aren't queued; see the online-only row) | An edit is never silently discarded; a retry of a 404 or 422 can't succeed | #19 |
| 2026-10-23 | What happens when the sign-in expires (401) while a timer runs? | Today the app goes to the sign-in screen; nothing is lost, but the user loses the timer screen and the end bell. Target: a running or paused timer stays on screen with its sounds, and sign-in comes once no timer runs. That is new work in #120 (P1), not a gap in #19 | AC13.1 promises timers and alerts work without a connection once signed in, so an expired sign-in shouldn't interrupt a session | #19, #120 |
| 2026-10-23 | Can Sign out appear on History, Settings and Archive, not just setup? | Yes: the account bar with Sign out is on setup, History, Settings and Archive, never over the timer or the session summary; every other sign-out rule is unchanged | "Setup only" was meant to protect a running or just-finished session; the refusal during a running or paused timer still guards that, and users look for Sign out in Settings (AC1.2) | #20, #22, #21 |
| 2026-10-23 | After a backwards clock jump while a timer is paused, what does the display show? | The shown time drops back by the size of the jump and then catches up. That is acceptable, with no follow-up | Display only: the saved record stays valid, it was already like this before the fix, and it only happens after a manual or NTP clock change mid-pause | #93 |
| 2026-10-23 | What happens to the legacy device keys `ineedtofocus.preferences`, `keepAwake` and `alertVolume` once settings sync (F12)? | They are never read, are removed at sign-out and owner switch, and are not migrated | Settings now come from the server; matches the ruling that `ineedtofocus.alertVolume` is not migrated | #22 |
| 2026-10-23 | What happens to settings edits that haven't been sent when the user signs out? | They must not be dropped silently. Sign-out tries to send them first, and anything still unsent adds "Some settings changes haven't synced and will be deleted from this device." to the confirmation. This is new work in #129 (P1, frontend), not a gap in #22 | Same rule as unsynced sessions and edits: an explicit sign-out may discard data only after an informed confirmation | #22, #129 |
| 2026-10-23 | Is the generated rain loop (AC8.3) good enough for the MVP? | Yes. Yacine listened on 2026-10-23: it sounds like a downpour rather than light rain, but he accepts it for the MVP as it is. The replacement, a real recording of light rain with several candidate samples for him to choose from (no generated or AI audio), is #135 (Post-MVP) | Yacine's decision; the loop meets the AC8.3 quality bar and works offline | #17, #135 |
| 2026-10-23 | Do archive, restore and delete-all work offline (F11)? | No, they are online only. A failure shows a message, and nothing is faked or lost | Keeps the Archive screen and history consistent with the server; these actions aren't queued | #21 |
| 2026-10-23 | Can a session that hasn't synced yet be archived? | No: it shows "Can be archived once it has synced." The exception for a session the server rejected (archive on this device only) is #139 | The server has no copy to archive yet | #21, #139 |
| 2026-10-23 | How does the user get out of a session or edit stuck at "Couldn't sync"? | It needs a way out, but that is new work and not a gap in #21. #133 covers a session archived or deleted elsewhere (409/404); #139 (P1) covers a refused edit (Discard change) and a rejected session (archive on this device only) | An item that can never sync shouldn't stay stuck on the device forever | #21, #133, #139 |
| 2026-10-25 | When the deploy that runs a contract migration fails its checks after starting, does the automatic revert go back to the release before it, which is now below the rollback floor? | No. The deploy fails with the "below the rollback floor ... Fix forward" message and the environment may run the new release unhealthy. On prod that means staying degraded or down until a fix-forward deploy, which goes through Yacine's approval like every prod deploy. To keep that window rare, a contract migration ships in its own small release, after the release whose code stopped using what it removes (deployment.md → Schema compatibility) | A revert is an automatic rollback, and the second AC of #165 refuses every rollback below the floor: a pre-contract release may fail or run half-broken on the contracted schema, which is worse than a visible outage. Prod deploys stay human-gated (process.md → Human gates) | #165 |
| 2026-10-25 | Does a contract migration that fails still set the rollback floor? | Yes, fail closed: the floor line is written before the migration runs. The environment keeps running its current release but has no rollback target until a release at or above the floor deploys | A migration cut short or run outside its transaction can leave the schema partly contracted, and focus-ci can't tell which; on Postgres a failure usually rolls back whole, so the cost is only no rollback target for a while, never a broken start | #165 |
