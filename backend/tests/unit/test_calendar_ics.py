"""The iCalendar generator (F14, #381): pure logic against the shared fixture.

`_docs/api/fixtures/calendar-events.json` gives, per case, the session, the settings and the
expected event as raw values and as exact serialized lines. `icalendar` only parses here: the
generator escapes and folds itself.
"""

import json
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

import pytest
from icalendar import Calendar

from app.calendar_ics import (
    CalendarSettings,
    EventSession,
    escape_text,
    export_filename,
    fold,
    format_duration,
    matches_etag,
    render_calendar,
    render_title,
)

FIXTURE_PATH = (
    Path(__file__).resolve().parents[3] / "_docs" / "api" / "fixtures" / "calendar-events.json"
)
FIXTURE = json.loads(FIXTURE_PATH.read_text(encoding="utf-8"))
ORIGIN: str = FIXTURE["origin"]
NAMES = {
    "work": "Work",
    "study": "Study",
    "nap": "Nap",
    "read": "Read",
    "meditation": "Meditation",
    "exercise": "Exercise",
}
NAMES |= {t["id"]: t["name"] for t in FIXTURE["tags"]}
NOW = datetime(2026, 11, 2, 12, 0, 0, 345, tzinfo=UTC)
CASES: list[dict[str, Any]] = FIXTURE["cases"]
IDS = [c["session"]["id"][-2:] for c in CASES]


def _event(case: dict[str, Any]) -> EventSession:
    s = case["session"]
    return EventSession(
        id=s["id"],
        mode=s["mode"],
        tag_name=NAMES.get(s["tag"], "Tag"),
        goal=s["goal"],
        started_at=datetime.fromisoformat(s["started_at"]),
        ended_at=datetime.fromisoformat(s["ended_at"]),
        focus_seconds=s["focus_seconds"],
        paused_seconds=s["paused_seconds"],
        ended_early=s["status"] == "ended_early",
        blocks=s["mode_config"].get("blocks") if s["mode"] == "pomodoro" else None,
        blocks_completed=s["blocks_completed"],
    )


def _settings(case: dict[str, Any]) -> CalendarSettings:
    s = case["settings"]
    return CalendarSettings(
        s["calendar_title_template"], s["calendar_include_goal"], s["calendar_include_description"]
    )


def _render(case: dict[str, Any], name: str = "Cal", feed: bool = True) -> bytes:
    return render_calendar(
        [_event(case)], _settings(case), name=name, origin=ORIGIN, feed=feed, now=NOW
    ).body


def _physical_lines(body: bytes) -> list[str]:
    """The physical lines of the file (folded ones still split)."""
    text = body.decode("utf-8")
    assert text.endswith("\r\n")
    assert "\n" not in text.replace("\r\n", "")  # CRLF line endings only
    return text[:-2].split("\r\n")


def _property(body: bytes, name: str) -> str | None:
    """One VEVENT property as serialized, folding included; None when absent."""
    lines = _physical_lines(body)
    starts = [i for i, line in enumerate(lines) if line.startswith(f"{name}:")]
    if not starts:
        return None
    end = starts[0] + 1
    while end < len(lines) and lines[end].startswith(" "):
        end += 1
    return "\r\n".join(lines[starts[0] : end])


def test_the_fixture_has_the_16_cases_the_spec_lists() -> None:
    assert len(CASES) == 16


@pytest.mark.parametrize("case", CASES, ids=IDS)
def test_ac14_2_every_serialized_line_matches_the_fixture(case: dict[str, Any]) -> None:
    body = _render(case)
    for name, expected in case["expected"]["ics"].items():
        assert _property(body, name) == expected, case["reason"]


@pytest.mark.parametrize("case", CASES, ids=IDS)
def test_ac14_2_a_real_parser_reads_the_fixture_values(case: dict[str, Any]) -> None:
    calendar = Calendar.from_ical(_render(case))
    event: Any
    (event,) = calendar.walk("VEVENT")
    want = case["expected"]
    assert str(event["UID"]) == want["uid"]
    assert event["DTSTART"].to_ical().decode() == want["dtstart"]
    assert event["DTEND"].to_ical().decode() == want["dtend"]
    assert str(event["SUMMARY"]) == want["summary"]
    if want["description"] is None:
        assert "DESCRIPTION" not in event
    else:
        assert str(event["DESCRIPTION"]) == want["description"]
    assert [str(c) for c in event["CATEGORIES"].cats] == [want["categories"]]
    assert str(event["TRANSP"]) == "TRANSPARENT"
    assert not event.subcomponents  # no alarms
    assert event["DTSTAMP"].to_ical().decode() == "20261102T120000Z"  # whole seconds, UTC


def test_ac14_2_calendar_header_and_feed_hints() -> None:
    body = _render(CASES[0])
    lines = _physical_lines(body)
    assert lines[:2] == ["BEGIN:VCALENDAR", "VERSION:2.0"]
    assert lines[2].startswith("PRODID:")
    assert "X-WR-CALNAME:Cal" in lines
    assert "REFRESH-INTERVAL;VALUE=DURATION:PT1H" in lines
    assert "X-PUBLISHED-TTL:PT1H" in lines
    assert lines[-1] == "END:VCALENDAR"
    assert str(Calendar.from_ical(body)["VERSION"]) == "2.0"
    download = _render(CASES[0], feed=False)
    assert b"REFRESH-INTERVAL" not in download
    assert b"X-PUBLISHED-TTL" not in download
    assert b"X-WR-CALNAME:Cal" in download


def test_a_calendar_with_no_sessions_is_valid() -> None:
    rendered = render_calendar(
        [], _settings(CASES[0]), name="Empty", origin=ORIGIN, feed=True, now=NOW
    )
    calendar = Calendar.from_ical(rendered.body)
    assert calendar.walk("VEVENT") == []
    assert str(calendar["X-WR-CALNAME"]) == "Empty"


def test_calendar_name_is_escaped_and_folded() -> None:
    name = "Focus, deep; work " + "é" * 60
    body = _render(CASES[0], name=name)
    # icalendar leaves X- properties escaped (it doesn't know their type), but unfolds them.
    assert str(Calendar.from_ical(body)["X-WR-CALNAME"]) == "Focus\\, deep\\; work " + "é" * 60
    assert max(len(line.encode()) for line in _physical_lines(body)) <= 75


@pytest.mark.parametrize("case", CASES, ids=IDS)
def test_every_line_is_within_75_octets(case: dict[str, Any]) -> None:
    body = _render(case)
    for line in _physical_lines(body):
        assert len(line.encode("utf-8")) <= 75
    body.decode("utf-8")  # valid UTF-8 throughout: no character was split


def test_fold_is_greedy_and_never_splits_a_character() -> None:
    assert fold("A" * 75) == "A" * 75
    assert fold("A" * 76) == "A" * 75 + "\r\n A"
    # 74 ASCII octets and then a 2-octet character: it doesn't fit on the first line.
    assert fold("A" * 74 + "é") == "A" * 74 + "\r\n é"
    # Continuations hold 74 octets after the leading space.
    assert fold("B" * 75 + "C" * 74 + "D") == "B" * 75 + "\r\n " + "C" * 74 + "\r\n D"
    # A 4-octet character at the boundary moves whole.
    assert fold("A" * 73 + "\U0001f600") == "A" * 73 + "\r\n \U0001f600"


def test_escape_text() -> None:
    assert escape_text("a\\b;c,d\ne") == "a\\\\b\\;c\\,d\\ne"
    assert escape_text("a\r\nb\rc") == "a\\nb\\nc"


def test_ac14_3_title_template_rules() -> None:
    values = {"tag": "Work", "goal": "", "mode": "Countdown", "focus_time": "25 min"}
    assert render_title("{tag}: {goal}", values) == "Work"
    assert render_title("{tag}: {goal}", {**values, "goal": "Write chapter 3"}) == (
        "Work: Write chapter 3"
    )
    assert render_title(" {goal} : ", values) == "Focus session"
    assert render_title("", values) == "Focus session"
    assert render_title("{unknown} {tag}", values) == "{unknown} Work"
    # A value's own placeholder text is not replaced (one pass).
    assert render_title("{goal} ({tag})", {**values, "goal": "Plan the {mode} talk"}) == (
        "Plan the {mode} talk (Work)"
    )
    assert render_title("{tag}:  {goal}  - {mode}", values) == "Work: - Countdown"
    assert render_title("- {tag} \N{EN DASH}", values) == "Work"


def test_format_duration_is_historys() -> None:
    assert [format_duration(s) for s in (40, 60, 1230, 3600, 3900, 7500)] == [
        "40 s",
        "1 min",
        "20 min",
        "1 h 00 min",
        "1 h 05 min",
        "2 h 05 min",
    ]


def test_etag_ignores_dtstamp_and_changes_with_content() -> None:
    case = CASES[0]
    event, settings = _event(case), _settings(case)

    def etag(sessions: list[EventSession], name: str = "A", origin: str = ORIGIN) -> str:
        return render_calendar(
            sessions, settings, name=name, origin=origin, feed=True, now=NOW
        ).etag

    first = render_calendar([event], settings, name="A", origin=ORIGIN, feed=True, now=NOW)
    later = render_calendar(
        [event],
        settings,
        name="A",
        origin=ORIGIN,
        feed=True,
        now=datetime(2027, 1, 1, tzinfo=UTC),
    )
    assert first.etag == later.etag
    assert first.body != later.body
    assert first.etag.startswith('W/"')
    assert (
        len({first.etag, etag([event], name="B"), etag([event], origin="http://dev"), etag([])})
        == 4
    )


def test_if_none_match_uses_weak_comparison() -> None:
    etag = 'W/"abc"'
    assert matches_etag('W/"abc"', etag)
    assert matches_etag('"abc"', etag)
    assert matches_etag('"x", W/"abc"', etag)
    assert matches_etag("*", etag)
    assert not matches_etag('"other"', etag)
    assert not matches_etag(None, etag)
    assert not matches_etag("", etag)


def test_ac14_6_export_filename() -> None:
    assert export_filename("2026-10-26", "2026-11-01") == (
        "ineedtofocus-2026-10-26-to-2026-11-01.ics"
    )
    assert export_filename("2026-10-26", "2026-10-26") == (
        "ineedtofocus-2026-10-26-to-2026-10-26.ics"
    )
    assert export_filename(None, None) == "ineedtofocus-all.ics"
