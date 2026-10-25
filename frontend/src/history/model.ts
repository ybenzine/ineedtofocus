// Pure history logic: local dates, periods, and merging the device's sessions into a view.
//
// The server answers for what it has. Sessions on the device that it doesn't have yet ("not
// synced yet" / "Couldn't sync", AC10.9) are added to the list, the totals, the per-tag
// breakdown and the chart, so a session finished a minute ago is never missing. Offline, the
// same code builds the whole view from the device's own sessions.

import type { Tag } from '../timer/config.ts'
import type {
  BucketUnit,
  HistoryBucket,
  HistoryData,
  HistorySession,
  HistoryView,
  TagTotal,
} from './api.ts'

const DAY_MS = 86_400_000
/** AC10.3 / #11 ruling: up to 62 days inclusive gets day bars, 63 or more month bars. */
export const MAX_DAY_BAR_RANGE = 62

/** `YYYY-MM-DD` as a UTC timestamp (calendar arithmetic only, no zones). */
function toMs(date: string): number {
  return Date.parse(`${date}T00:00:00Z`)
}

function fromMs(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10)
}

export function addDays(date: string, days: number): string {
  return fromMs(toMs(date) + days * DAY_MS)
}

export function firstOfMonth(date: string): string {
  return `${date.slice(0, 7)}-01`
}

export function addMonths(date: string, months: number): string {
  const d = new Date(toMs(firstOfMonth(date)))
  d.setUTCMonth(d.getUTCMonth() + months)
  return fromMs(d.getTime())
}

export function lastOfMonth(date: string): string {
  return addDays(addMonths(date, 1), -1)
}

export function daysBetween(start: string, end: string): number {
  return Math.round((toMs(end) - toMs(start)) / DAY_MS)
}

/** The local calendar date of an instant in `timeZone` (AC10.5). */
export function localDate(iso: string, timeZone: string): string {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(new Date(iso))
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? ''
  return `${get('year')}-${get('month')}-${get('day')}`
}

export interface Period {
  start: string
  end: string
}

/** The days a day/week/month view covers around `anchor`. */
export function periodFor(
  view: 'day' | 'week' | 'month',
  anchor: string,
  weekStartDay: number,
): Period {
  if (view === 'day') return { start: anchor, end: anchor }
  if (view === 'month') return { start: firstOfMonth(anchor), end: lastOfMonth(anchor) }
  const dow = new Date(toMs(anchor)).getUTCDay()
  const start = addDays(anchor, -((dow - weekStartDay + 7) % 7))
  return { start, end: addDays(start, 6) }
}

/** Moves the anchor by one period (AC10.1 previous/next). */
export function shiftAnchor(view: 'day' | 'week' | 'month', anchor: string, step: 1 | -1): string {
  if (view === 'day') return addDays(anchor, step)
  if (view === 'week') return addDays(anchor, 7 * step)
  return addMonths(anchor, step)
}

export function bucketUnitFor(view: HistoryView, period: Period | null): BucketUnit {
  if (view === 'all') return 'month'
  if (view === 'custom' && period && daysBetween(period.start, period.end) + 1 > MAX_DAY_BAR_RANGE)
    return 'month'
  return 'day'
}

function zeroBuckets(unit: BucketUnit, start: string, end: string): HistoryBucket[] {
  const out: HistoryBucket[] = []
  if (unit === 'day') {
    for (let d = start; d <= end; d = addDays(d, 1))
      out.push({ date: d, focusSeconds: 0, sessions: 0 })
  } else {
    for (let d = firstOfMonth(start); d <= end; d = addMonths(d, 1))
      out.push({ date: d, focusSeconds: 0, sessions: 0 })
  }
  return out
}

/** A view with nothing in it, for `period` (null: All time with no sessions). */
export function emptyData(
  view: HistoryView,
  timeZone: string,
  weekStartDay: number,
  period: Period | null,
): HistoryData {
  const unit = bucketUnitFor(view, period)
  return {
    view,
    timeZone,
    weekStartDay,
    start: period?.start ?? null,
    end: period?.end ?? null,
    bucket: unit,
    totalFocusSeconds: 0,
    sessionCount: 0,
    tags: [],
    buckets: period ? zeroBuckets(unit, period.start, period.end) : [],
    sessions: [],
  }
}

/**
 * Adds `extra` sessions (from the device) to `base`: those not already in it, with a tag in
 * `tags` (empty: all), and whose local start date falls inside the period (All time: any).
 */
export function mergeSessions(
  base: HistoryData,
  extra: readonly HistorySession[],
  tags: readonly Tag[],
): HistoryData {
  const known = new Set(base.sessions.map((s) => s.id))
  const added = extra.filter((s) => {
    if (known.has(s.id)) return false
    if (tags.length > 0 && !tags.includes(s.tag)) return false
    if (base.view === 'all') return true
    if (base.start === null || base.end === null) return false
    const day = localDate(s.startedAt, base.timeZone)
    return day >= base.start && day <= base.end
  })
  if (added.length === 0) return base

  const days = added.map((s) => localDate(s.startedAt, base.timeZone))
  let start = base.start
  let end = base.end
  if (base.view === 'all') {
    start = [start, ...days].filter((d) => d !== null).sort()[0] ?? null
    end =
      [end, ...days]
        .filter((d) => d !== null)
        .sort()
        .reverse()[0] ?? null
  }

  const byKey = new Map(base.buckets.map((b) => [b.date, { ...b }]))
  if (base.view === 'all' && start && end) {
    for (const b of zeroBuckets('month', start, end)) if (!byKey.has(b.date)) byKey.set(b.date, b)
  }
  const tagTotals = new Map<Tag, TagTotal>(base.tags.map((t) => [t.tag, { ...t }]))
  let total = base.totalFocusSeconds
  added.forEach((s, i) => {
    const day = days[i]
    const key = base.bucket === 'month' ? firstOfMonth(day) : day
    const bucket = byKey.get(key)
    if (bucket) {
      bucket.focusSeconds += s.focusSeconds
      bucket.sessions += 1
    }
    const t = tagTotals.get(s.tag) ?? { tag: s.tag, focusSeconds: 0, sessions: 0 }
    t.focusSeconds += s.focusSeconds
    t.sessions += 1
    tagTotals.set(s.tag, t)
    total += s.focusSeconds
  })

  return {
    ...base,
    start,
    end,
    totalFocusSeconds: total,
    sessionCount: base.sessionCount + added.length,
    tags: [...tagTotals.values()].sort((a, b) => b.focusSeconds - a.focusSeconds),
    buckets: [...byKey.values()].sort((a, b) => a.date.localeCompare(b.date)),
    sessions: [...base.sessions, ...added].sort((a, b) => b.startedAt.localeCompare(a.startedAt)),
  }
}

const LOCALE = undefined

function fmt(date: string, options: Intl.DateTimeFormatOptions): string {
  return new Intl.DateTimeFormat(LOCALE, { timeZone: 'UTC', ...options }).format(
    new Date(`${date}T12:00:00Z`),
  )
}

/** "Mon, 12 Oct 2026", "11 – 17 Oct 2026", "October 2026", "All time". */
export function periodLabel(data: HistoryData): string {
  if (data.view === 'all') return 'All time'
  if (!data.start || !data.end) return ''
  if (data.view === 'day')
    return fmt(data.start, { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' })
  if (data.view === 'month') return fmt(data.start, { month: 'long', year: 'numeric' })
  const short = { day: 'numeric', month: 'short', year: 'numeric' } as const
  return `${fmt(data.start, short)} – ${fmt(data.end, short)}`
}

/** Full label of a bar for screen readers: "Mon 12 Oct" or "October 2026". */
export function bucketTitle(bucket: HistoryBucket, unit: BucketUnit): string {
  return unit === 'month'
    ? fmt(bucket.date, { month: 'long', year: 'numeric' })
    : fmt(bucket.date, { weekday: 'short', day: 'numeric', month: 'short' })
}

/** The short label under a bar: weekday for a week, day number, or month (AC10.3). */
export function bucketLabel(bucket: HistoryBucket, data: HistoryData): string {
  if (data.bucket === 'month') {
    const multiYear = data.buckets.some((b) => b.date.slice(0, 4) !== bucket.date.slice(0, 4))
    return fmt(bucket.date, multiYear ? { month: 'short', year: '2-digit' } : { month: 'short' })
  }
  return data.view === 'week'
    ? fmt(bucket.date, { weekday: 'short' })
    : String(Number(bucket.date.slice(8)))
}

export function formatDate(iso: string, timeZone: string): string {
  return new Intl.DateTimeFormat(LOCALE, {
    timeZone,
    weekday: 'short',
    day: 'numeric',
    month: 'short',
    year: 'numeric',
  }).format(new Date(iso))
}

export function formatTime(iso: string, timeZone: string): string {
  return new Intl.DateTimeFormat(LOCALE, { timeZone, hour: '2-digit', minute: '2-digit' }).format(
    new Date(iso),
  )
}

/** Goals are one line (AC7.3): line breaks become spaces. */
export function oneLine(text: string): string {
  return text.replace(/\s*[\r\n]+\s*/g, ' ')
}

function sortedTags(tags: Map<Tag, TagTotal>): TagTotal[] {
  return [...tags.values()]
    .filter((t) => t.sessions > 0)
    .sort((a, b) => b.focusSeconds - a.focusSeconds)
}

/** The view without the sessions `ids` (archived): list, totals, tag breakdown and bars. */
export function removeSessions(base: HistoryData, ids: ReadonlySet<string>): HistoryData {
  const gone = base.sessions.filter((s) => ids.has(s.id))
  if (gone.length === 0) return base
  const byKey = new Map(base.buckets.map((b) => [b.date, { ...b }]))
  const tagTotals = new Map<Tag, TagTotal>(base.tags.map((t) => [t.tag, { ...t }]))
  let total = base.totalFocusSeconds
  for (const s of gone) {
    const day = localDate(s.startedAt, base.timeZone)
    const bucket = byKey.get(base.bucket === 'month' ? firstOfMonth(day) : day)
    if (bucket) {
      bucket.focusSeconds -= s.focusSeconds
      bucket.sessions -= 1
    }
    const t = tagTotals.get(s.tag)
    if (t) {
      t.focusSeconds -= s.focusSeconds
      t.sessions -= 1
    }
    total -= s.focusSeconds
  }
  return {
    ...base,
    totalFocusSeconds: Math.max(0, total),
    sessionCount: base.sessionCount - gone.length,
    tags: sortedTags(tagTotals),
    buckets: [...byKey.values()],
    sessions: base.sessions.filter((s) => !ids.has(s.id)),
  }
}

export interface SessionChange {
  tag?: Tag
  goal?: string | null
  indicator?: HistorySession['indicator']
  editRejected?: boolean
}

/**
 * Applies changes the device holds but the server hasn't confirmed (AC11.1) to the sessions of
 * `base`, moving their time between tags in the breakdown. Which sessions a tag filter shows is
 * still the server's call.
 */
export function applyChanges(
  base: HistoryData,
  changes: ReadonlyMap<string, SessionChange>,
): HistoryData {
  if (!base.sessions.some((s) => changes.has(s.id))) return base
  const tagTotals = new Map<Tag, TagTotal>(base.tags.map((t) => [t.tag, { ...t }]))
  const sessions = base.sessions.map((s) => {
    const change = changes.get(s.id)
    if (!change) return s
    if (change.tag !== undefined && change.tag !== s.tag) {
      const from = tagTotals.get(s.tag)
      if (from) {
        from.focusSeconds -= s.focusSeconds
        from.sessions -= 1
      }
      const to = tagTotals.get(change.tag) ?? { tag: change.tag, focusSeconds: 0, sessions: 0 }
      to.focusSeconds += s.focusSeconds
      to.sessions += 1
      tagTotals.set(change.tag, to)
    }
    return { ...s, ...change }
  })
  return { ...base, sessions, tags: sortedTags(tagTotals) }
}

const EDGE_MARGIN_MS = 3 * 60 * 60 * 1000

/**
 * Ids of the device's synced sessions that the server's answer should list but doesn't: they
 * were archived or deleted on another device. Left out, to be safe: sessions the server
 * may not have, ones already archived here or in `skip`, and any view with a tag filter (the
 * device's tag could be stale, and then a session would look gone when it is only filtered out).
 * Sessions within 3 hours of a period's edge are left out too: tz data can differ between the
 * browser and the server, so they might be inside the period for one and not the other.
 */
export function missingFromServer(
  base: HistoryData,
  device: readonly { id: string; startedAt: string; synced: boolean; archived: boolean }[],
  tags: readonly Tag[],
  skip: ReadonlySet<string>,
): string[] {
  if (tags.length > 0) return []
  const known = new Set(base.sessions.map((s) => s.id))
  return device
    .filter((d) => {
      if (!d.synced || d.archived || known.has(d.id) || skip.has(d.id)) return false
      if (base.view === 'all') return true
      const { start, end } = base
      if (start === null || end === null) return false
      // The browser's and the server's tz data can differ by an hour or so for some zones, so a
      // session near a period edge might be in the period for one and not the other: only
      // trust it if it is inside the period with a margin either way.
      const t = Date.parse(d.startedAt)
      return [t - EDGE_MARGIN_MS, t + EDGE_MARGIN_MS].every((ms) => {
        const day = localDate(new Date(ms).toISOString(), base.timeZone)
        return day >= start && day <= end
      })
    })
    .map((d) => d.id)
}

/**
 * Ids of device sessions marked archived that the server's answer lists as live: they were
 * restored on another device. Tag filters don't matter here (a listed session is live either way).
 */
export function listedAsLive(
  base: HistoryData,
  device: readonly { id: string; archived: boolean }[],
): string[] {
  const known = new Set(base.sessions.map((s) => s.id))
  return device.filter((d) => d.archived && known.has(d.id)).map((d) => d.id)
}
