"""The iCalendar (RFC 5545) generator behind the feed and the History download (F14, #381).

Pure functions, no database. The event format is AC14.2-AC14.3 and the expected output is
`_docs/api/fixtures/calendar-events.json`, which the tests compare byte for byte. The
generator escapes and folds lines itself: a library serializer may fold differently
(`icalendar` folds its first line at 74 octets), so `icalendar` is a test-only parser.

Privacy: goals and custom tag names are user content (AC14.8). Nothing here logs.
"""

import hashlib
import re
from collections.abc import Iterable
from dataclasses import dataclass
from datetime import UTC, datetime

CRLF = "\r\n"
UID_DOMAIN = "ineedtofoc.us"
PRODID = "-//I Need To Focus//Calendar export//EN"
REFRESH = "PT1H"
FALLBACK_TITLE = "Focus session"

_MODE_NAMES = {"countdown": "Countdown", "pomodoro": "Pomodoro", "unlimited": "Unlimited"}
_PLACEHOLDER = re.compile(r"\{(tag|goal|mode|focus_time)\}")
_SPACES = re.compile(r" {2,}")
# AC14.3: spaces and these separators left at either end of the title are trimmed.
_TRIM = " \u00b7:-\u2013"  # space, middle dot, colon, hyphen, en dash
# Every boundary str.splitlines() recognises, as for goals (sessions.one_line_goal).
_LINE_BREAKS = re.compile(r"[\r\n\x0b\x0c\x1c\x1d\x1e\x85\u2028\u2029]+")
_TEXT_ESCAPES = str.maketrans({"\\": "\\\\", ";": "\\;", ",": "\\,", "\n": "\\n"})


@dataclass(frozen=True)
class CalendarSettings:
    """The calendar settings that shape an event (AC12.8)."""

    title_template: str
    include_goal: bool
    include_description: bool


@dataclass(frozen=True)
class EventSession:
    """A session as the event needs it. `tag_name` is the tag's display name."""

    id: str
    mode: str
    tag_name: str
    goal: str | None
    started_at: datetime
    ended_at: datetime
    focus_seconds: int
    paused_seconds: int
    ended_early: bool
    blocks: int | None  # the Pomodoro configuration's blocks; None for other modes
    blocks_completed: int


def format_duration(total_seconds: int) -> str:
    """History's format: `1 h 05 min`, `25 min`, `40 s`."""
    hours = total_seconds // 3600
    minutes = total_seconds % 3600 // 60
    if hours > 0:
        return f"{hours} h {minutes:02d} min"
    if minutes > 0:
        return f"{minutes} min"
    return f"{total_seconds} s"


def render_title(template: str, values: dict[str, str]) -> str:
    """AC14.3: one pass over the placeholders (text a value brings in is never rescanned),
    spaces collapsed, ends trimmed of spaces and separators; empty reads "Focus session"."""
    text = _PLACEHOLDER.sub(lambda m: values[m.group(1)], template)
    text = _SPACES.sub(" ", text).strip(_TRIM)
    return text or FALLBACK_TITLE


def escape_text(value: str) -> str:
    """TEXT escaping: backslash, semicolon, comma and line break (`\\n`)."""
    return value.replace("\r\n", "\n").replace("\r", "\n").translate(_TEXT_ESCAPES)


def fold(line: str) -> str:
    """Fold a content line at 75 octets (continuations: a space plus at most 74), greedily,
    never inside a UTF-8 character. Acts on the already escaped line. No trailing CRLF."""
    data = line.encode("utf-8")
    if len(data) <= 75:
        return line
    parts: list[bytes] = []
    pos, limit = 0, 75
    while len(data) - pos > limit:
        end = pos + limit
        while data[end] & 0xC0 == 0x80:  # a continuation byte: back up to the character start
            end -= 1
        parts.append(data[pos:end])
        pos, limit = end, 74
    parts.append(data[pos:])
    return (CRLF + " ").join(p.decode("utf-8") for p in parts)


def _stamp(instant: datetime) -> str:
    """UTC `20261030T090000Z`, to the whole second (fractions are dropped)."""
    return instant.astimezone(UTC).strftime("%Y%m%dT%H%M%SZ")


def _line(name: str, value: str) -> str:
    return fold(f"{name}:{value}")


def event_text(session: EventSession, settings: CalendarSettings, origin: str) -> dict[str, str]:
    """The raw (unescaped) text values of an event: summary, description (`""` when off)."""
    goal = _LINE_BREAKS.sub(" ", session.goal) if session.goal else ""
    if not settings.include_goal:
        goal = ""
    mode = _MODE_NAMES.get(session.mode, session.mode.capitalize())
    focus_time = format_duration(session.focus_seconds)
    summary = render_title(
        settings.title_template,
        {"tag": session.tag_name, "goal": goal, "mode": mode, "focus_time": focus_time},
    )
    description = ""
    if settings.include_description:
        lines = [f"Goal: {goal}"] if goal else []
        lines += [f"Tag: {session.tag_name}", f"Mode: {mode}", f"Focus time: {focus_time}"]
        if session.paused_seconds > 0:
            lines.append(f"Paused: {format_duration(session.paused_seconds)}")
        if session.mode == "pomodoro" and session.blocks is not None:
            lines.append(f"Blocks completed: {session.blocks_completed} of {session.blocks}")
        if session.ended_early:
            lines.append("Ended early")
        lines.append(f"History: {origin}/history")
        description = "\n".join(lines)
    return {"summary": summary, "description": description}


def event_lines(
    session: EventSession, settings: CalendarSettings, origin: str
) -> tuple[list[str], list[str]]:
    """The folded property lines of one VEVENT, split around DTSTAMP so the feed's ETag can
    ignore the time the file was made: (BEGIN and UID, everything after DTSTAMP)."""
    text = event_text(session, settings, origin)
    head = ["BEGIN:VEVENT", f"UID:{session.id}@{UID_DOMAIN}"]
    tail = [
        f"DTSTART:{_stamp(session.started_at)}",
        f"DTEND:{_stamp(session.ended_at)}",
        _line("SUMMARY", escape_text(text["summary"])),
    ]
    if settings.include_description:
        tail.append(_line("DESCRIPTION", escape_text(text["description"])))
    tail += [
        _line("CATEGORIES", escape_text(session.tag_name)),
        "TRANSP:TRANSPARENT",
        "END:VEVENT",
    ]
    return head, tail


@dataclass(frozen=True)
class Rendered:
    body: bytes
    etag: str  # weak validator of everything but DTSTAMP, as `W/"..."`


def render_calendar(
    sessions: Iterable[EventSession],
    settings: CalendarSettings,
    *,
    name: str,
    origin: str,
    feed: bool,
    now: datetime,
) -> Rendered:
    """A whole VCALENDAR as CRLF-terminated UTF-8, with a weak ETag that changes whenever the
    content would. `feed` adds the refresh hints (REFRESH-INTERVAL, X-PUBLISHED-TTL)."""
    header = [
        "BEGIN:VCALENDAR",
        "VERSION:2.0",
        f"PRODID:{PRODID}",
        "CALSCALE:GREGORIAN",
        "METHOD:PUBLISH",
        _line("X-WR-CALNAME", escape_text(name)),
    ]
    if feed:
        header += [f"REFRESH-INTERVAL;VALUE=DURATION:{REFRESH}", f"X-PUBLISHED-TTL:{REFRESH}"]
    dtstamp = f"DTSTAMP:{_stamp(now.replace(microsecond=0))}"
    digest = hashlib.sha256()
    out: list[str] = header
    digest.update(CRLF.join(header).encode("utf-8"))
    for session in sessions:
        head, tail = event_lines(session, settings, origin)
        digest.update(b"\0")
        digest.update(CRLF.join((*head, *tail)).encode("utf-8"))
        out += (*head, dtstamp, *tail)
    out.append("END:VCALENDAR")
    body = (CRLF.join(out) + CRLF).encode("utf-8")
    return Rendered(body=body, etag=f'W/"{digest.hexdigest()[:32]}"')


def matches_etag(if_none_match: str | None, etag: str) -> bool:
    """RFC 9110 weak comparison of an `If-None-Match` header with our ETag."""
    if not if_none_match:
        return False
    wanted = etag.removeprefix("W/")
    for candidate in if_none_match.split(","):
        candidate = candidate.strip()
        if candidate == "*" or candidate.removeprefix("W/") == wanted:
            return True
    return False


def export_filename(first: str | None, last: str | None) -> str:
    """`ineedtofocus-<first>-to-<last>.ics`, or `ineedtofocus-all.ics` without a range."""
    if first is None or last is None:
        return "ineedtofocus-all.ics"
    return f"ineedtofocus-{first}-to-{last}.ics"
