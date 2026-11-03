"""Calendar export (F14, #381): feed management, the subscription feed, the History download
and calendar settings, against a real, migrated, throwaway Postgres."""

import datetime as dt
import io
import json
import logging
import time
import uuid
from collections.abc import Iterator
from typing import Any

import pytest
from fastapi.testclient import TestClient
from httpx import Response
from icalendar import Calendar
from opentelemetry.sdk.trace import TracerProvider
from opentelemetry.sdk.trace.export import SimpleSpanProcessor
from opentelemetry.sdk.trace.export.in_memory_span_exporter import InMemorySpanExporter
from sqlalchemy import text
from sqlalchemy.ext.asyncio import create_async_engine

from app.calendar_api import new_limiters
from app.config import Settings
from app.logging_config import JsonFormatter
from app.main import create_app
from app.models.enums import TAGS
from app.rate_limit import FailureLimiter
from app.security import token_hash
from app.telemetry import install_privacy_filters
from tests.integration.conftest import PASSWORD, MakeClient, run, signup
from tests.integration.test_sessions import _query, make_session

pytestmark = pytest.mark.integration


@pytest.fixture(autouse=True)
def _fixed_now(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr("app.sessions._now", lambda: dt.datetime(2030, 1, 1, tzinfo=dt.UTC))


POMODORO = {
    "mode": "pomodoro",
    "focus_minutes": 25,
    "break_minutes": 5,
    "blocks": 4,
    "long_break_enabled": False,
    "long_break_minutes": 15,
}
GOAL = "Confidential merger plan"
TAG_NAME = "Zebrafish, ledger"


def save(c: TestClient, started_at: str, minutes: int = 25, **over: Any) -> str:
    start = dt.datetime.fromisoformat(started_at).replace(tzinfo=dt.UTC)
    body = make_session(
        started_at=start.isoformat(),
        ended_at=(start + dt.timedelta(minutes=minutes)).isoformat(),
        focus_seconds=minutes * 60,
        paused_seconds=0,
        mode_config={"mode": "countdown", "minutes": minutes},
        **over,
    )
    r = c.post("/api/sessions", json=body)
    assert r.status_code == 201, r.text
    session_id: str = body["id"]
    return session_id


async def _exec(url: str, sql: str) -> None:
    engine = create_async_engine(url)
    try:
        async with engine.begin() as conn:
            await conn.execute(text(sql))
    finally:
        await engine.dispose()


def make_feed(c: TestClient) -> str:
    """Turn the feed on; the secret path."""
    r = c.post("/api/calendar/feed")
    assert r.status_code in (200, 201), r.text
    path: str = r.json()["path"]
    return path


def events(r: Response) -> list[Any]:
    assert r.status_code == 200, r.text
    return list(Calendar.from_ical(r.content).walk("VEVENT"))


def uids(r: Response) -> list[str]:
    return [str(e["UID"]).split("@")[0] for e in events(r)]


# --- settings (AC1) ------------------------------------------------------------------------


def test_ac1_settings_defaults_patch_and_account_export(ada: TestClient) -> None:
    got = ada.get("/api/settings").json()
    assert got["calendar_title_template"] == "{tag}: {goal}"
    assert got["calendar_include_goal"] is True
    assert got["calendar_include_description"] is True
    assert got["calendar_excluded_tags"] == []
    assert got["calendar_min_minutes"] == 0
    assert got["calendar_name"] == "I Need To Focus"
    tag = ada.post("/api/tags", json={"name": "Piano", "color": "teal"}).json()["id"]
    ada.post(f"/api/tags/{tag}/remove")  # removed tags are still valid choices
    patch = {
        "calendar_title_template": "{mode} {tag}",
        "calendar_include_goal": False,
        "calendar_include_description": False,
        "calendar_excluded_tags": ["nap", tag],
        "calendar_min_minutes": 15,
        "calendar_name": "  My focus  ",
    }
    r = ada.patch("/api/settings", json=patch)
    assert r.status_code == 200, r.text
    assert r.json()["calendar_name"] == "My focus"
    assert r.json()["calendar_excluded_tags"] == ["nap", tag]
    assert ada.get("/api/settings").json() == r.json()
    # An omitted field is unchanged.
    patched = ada.patch("/api/settings", json={"week_start_day": 5}).json()
    assert patched["calendar_min_minutes"] == 15
    export = ada.get("/api/account/export").json()
    assert export["settings"]["calendar_excluded_tags"] == ["nap", tag]
    assert export["settings"]["calendar_name"] == "My focus"


@pytest.mark.parametrize(
    "patch",
    [
        {"calendar_title_template": "x" * 121},
        {"calendar_title_template": "a\x00b"},
        {"calendar_title_template": "a\nb"},
        {"calendar_title_template": "a\x1fb"},
        {"calendar_title_template": None},
        {"calendar_include_goal": "yes"},
        {"calendar_include_description": None},
        {"calendar_min_minutes": 7},
        {"calendar_min_minutes": "5"},
        {"calendar_name": "   "},
        {"calendar_name": ""},
        {"calendar_name": "x" * 61},
        {"calendar_name": "a\x00b"},
        {"calendar_excluded_tags": "work"},
        {"calendar_excluded_tags": None},
        {"calendar_excluded_tags": ["Gaming"]},
        {"calendar_excluded_tags": ["work", "work"]},
        {"calendar_excluded_tags": [str(uuid.uuid4())]},
        {"calendar_excluded_tags": ["work"] * 107},
    ],
    ids=lambda p: next(iter(p)) + ":" + repr(next(iter(p.values())))[:20],
)
def test_ac1_invalid_calendar_settings_are_422_and_never_echoed(
    ada: TestClient, patch: dict[str, Any]
) -> None:
    r = ada.patch("/api/settings", json=patch)
    assert r.status_code == 422, r.text
    assert "Gaming" not in r.text
    assert ada.get("/api/settings").json()["calendar_min_minutes"] == 0


def test_ac1_lone_surrogates_are_422(ada: TestClient) -> None:
    for field in ("calendar_title_template", "calendar_name"):
        r = ada.patch(
            "/api/settings",
            content=f'{{"{field}": "a\\ud800b"}}',
            headers={"content-type": "application/json"},
        )
        assert r.status_code == 422, r.text


def test_ac1_title_template_of_120_characters_and_name_of_60_are_accepted(
    ada: TestClient,
) -> None:
    r = ada.patch(
        "/api/settings", json={"calendar_title_template": "é" * 120, "calendar_name": "n" * 60}
    )
    assert r.status_code == 200
    assert ada.patch("/api/settings", json={"calendar_excluded_tags": []}).status_code == 200


def test_ac1_another_accounts_tag_cannot_be_excluded(ada: TestClient, bob: TestClient) -> None:
    theirs = bob.post("/api/tags", json={"name": "Theirs", "color": "red"}).json()["id"]
    r = ada.patch("/api/settings", json={"calendar_excluded_tags": [theirs]})
    assert r.status_code == 422
    assert "Theirs" not in r.text
    # Indistinguishable from an id that exists nowhere.
    other = ada.patch("/api/settings", json={"calendar_excluded_tags": [str(uuid.uuid4())]})
    assert other.json() == r.json()
    assert (
        ada.patch("/api/settings", json={"calendar_excluded_tags": ["work"] * 1}).status_code == 200
    )


def test_ac1_excluded_tags_limit_is_106(ada: TestClient, app_url: str) -> None:
    """6 built-ins plus the 100 custom tags an account can ever have (removed ones included)."""
    run(
        _exec(
            app_url,
            "INSERT INTO custom_tags (user_id, name, color, removed_at) "
            "SELECT u.id, 'tag ' || n, 'teal', CASE WHEN n > 20 THEN now() END "
            "FROM generate_series(1, 100) AS n, (SELECT id FROM users LIMIT 1) AS u",
        )
    )
    custom = [t["id"] for t in ada.get("/api/tags").json()["tags"]]
    assert len(custom) == 100
    everything = [*TAGS, *custom]
    assert len(everything) == 106 and len(set(everything)) == 106
    r = ada.patch("/api/settings", json={"calendar_excluded_tags": everything})
    assert r.status_code == 200, r.text
    assert len(r.json()["calendar_excluded_tags"]) == 106
    too_many = ada.patch(
        "/api/settings", json={"calendar_excluded_tags": [*everything, str(uuid.uuid4())]}
    )
    assert too_many.status_code == 422
    assert len(ada.get("/api/settings").json()["calendar_excluded_tags"]) == 106


# --- managing the feed (AC3, AC2) ----------------------------------------------------------


def test_ac3_management_needs_sign_in(make_client: MakeClient) -> None:
    with make_client() as c:
        assert c.get("/api/calendar/feed").status_code == 401
        assert c.post("/api/calendar/feed").status_code == 401
        assert c.delete("/api/calendar/feed").status_code == 401
        assert c.get("/api/calendar/export.ics?view=all&tz=UTC").status_code == 401


def test_ac3_create_status_reset_and_turn_off(ada: TestClient) -> None:
    assert ada.get("/api/calendar/feed").json() == {
        "enabled": False,
        "created_at": None,
        "last_fetched_at": None,
    }
    made = ada.post("/api/calendar/feed")
    assert made.status_code == 201
    assert made.headers["cache-control"] == "no-store"
    path = made.json()["path"]
    assert path.startswith("/api/calendar/") and path.endswith(".ics")
    assert len(path) == len("/api/calendar/") + 43 + len(".ics")
    status = ada.get("/api/calendar/feed")
    assert status.json() == {
        "enabled": True,
        "created_at": made.json()["created_at"],
        "last_fetched_at": None,
    }
    assert path.split("/")[-1].removesuffix(".ics") not in status.text  # never the link
    assert ada.get(path).status_code == 200

    reset = ada.post("/api/calendar/feed")
    assert reset.status_code == 200
    new_path = reset.json()["path"]
    assert new_path != path
    assert ada.get(path).status_code == 404  # the old secret stops working at once
    assert ada.get(new_path).status_code == 200

    assert ada.delete("/api/calendar/feed").status_code == 204
    assert ada.delete("/api/calendar/feed").status_code == 204  # idempotent
    assert ada.get("/api/calendar/feed").json()["enabled"] is False
    assert ada.get(new_path).status_code == 404
    # Reset after a reset starts clean: not yet fetched.
    again = ada.post("/api/calendar/feed")
    assert again.status_code == 201
    assert ada.get("/api/calendar/feed").json()["last_fetched_at"] is None


def test_ac2_only_the_hash_is_stored_and_nothing_leaks_into_the_export(
    ada: TestClient, app_url: str
) -> None:
    secret = make_feed(ada).split("/")[-1].removesuffix(".ics")
    rows = run(_query(app_url, "SELECT token_hash FROM calendar_feeds"))
    assert [r[0] for r in rows] == [token_hash(secret)]
    assert len(secret) == 43
    export = ada.get("/api/account/export").text
    assert secret not in export
    assert token_hash(secret) not in export
    assert "calendar_feeds" not in export and "token_hash" not in export
    assert secret not in ada.get("/api/settings").text


def test_ac3_a_feed_belongs_to_one_account(ada: TestClient, bob: TestClient) -> None:
    save(ada, "2026-10-30T09:00:00", goal="Ada only")
    save(bob, "2026-10-30T10:00:00", goal="Bob only")
    ada_path, bob_path = make_feed(ada), make_feed(bob)
    assert "Ada only" in ada.get(ada_path).text
    assert "Bob only" not in ada.get(ada_path).text
    assert "Bob only" in ada.get(bob_path).text
    assert "Ada only" not in ada.get(bob_path).text
    # Bob turning his feed off doesn't touch Ada's.
    bob.delete("/api/calendar/feed")
    assert ada.get(ada_path).status_code == 200
    assert bob.get("/api/calendar/feed").json()["enabled"] is False


# --- the feed (AC4) ------------------------------------------------------------------------


def test_ac4_feed_response_headers_event_and_constant_properties(
    ada: TestClient, make_client: MakeClient
) -> None:
    session = save(ada, "2026-10-30T09:00:00", goal="Write, plan; ship")
    path = make_feed(ada)
    with make_client() as anonymous:  # not signed in: the secret is the credential
        r = anonymous.get(path)
    assert r.status_code == 200
    assert r.headers["content-type"] == "text/calendar; charset=utf-8"
    assert r.headers["cache-control"] == "private, no-cache"
    assert r.headers["etag"].startswith('W/"')
    lines = r.content.decode().split("\r\n")
    assert lines[-1] == "" and "\n" not in "".join(lines)
    assert "VERSION:2.0" in lines
    assert any(line.startswith("PRODID:") for line in lines)
    assert "X-WR-CALNAME:I Need To Focus" in lines
    assert "REFRESH-INTERVAL;VALUE=DURATION:PT1H" in lines
    assert "X-PUBLISHED-TTL:PT1H" in lines
    assert "TRANSP:TRANSPARENT" in lines
    assert "CATEGORIES:Work" in lines
    assert "BEGIN:VALARM" not in lines
    assert any(line.startswith("DTSTAMP:") and line.endswith("Z") for line in lines)
    assert f"UID:{session}@ineedtofoc.us" in lines
    assert "SUMMARY:Work: Write\\, plan\\; ship" in lines
    (event,) = events(r)
    assert str(event["SUMMARY"]) == "Work: Write, plan; ship"
    assert "History: http://testserver/history" in str(event["DESCRIPTION"])


def test_ac4_history_link_uses_the_origin_the_request_reached(ada: TestClient) -> None:
    save(ada, "2026-10-30T09:00:00")
    path = make_feed(ada)
    r = ada.get(path, headers={"host": "dev.ineedtofoc.us"})
    assert "History: http://dev.ineedtofoc.us/history" in str(events(r)[0]["DESCRIPTION"])


def test_ac4_newest_first_archived_excluded_and_edits_show(ada: TestClient) -> None:
    old = save(ada, "2026-10-28T09:00:00")
    new = save(ada, "2026-10-30T09:00:00", goal="Before")
    mid = save(ada, "2026-10-29T09:00:00")
    path = make_feed(ada)
    assert uids(ada.get(path)) == [new, mid, old]
    assert ada.post(f"/api/sessions/{mid}/archive").status_code == 200
    assert uids(ada.get(path)) == [new, old]
    assert ada.post(f"/api/sessions/{mid}/restore").status_code == 200
    assert uids(ada.get(path)) == [new, mid, old]
    assert (
        ada.patch(f"/api/sessions/{new}", json={"goal": "After", "tag": "study"}).status_code == 200
    )
    (first, *_) = events(ada.get(path))
    assert str(first["SUMMARY"]) == "Study: After"


def test_ac4_custom_tags_by_current_name_and_tag_filter(ada: TestClient) -> None:
    custom = ada.post("/api/tags", json={"name": TAG_NAME, "color": "teal"}).json()["id"]
    a = save(ada, "2026-10-30T09:00:00", tag=custom, goal=None)
    b = save(ada, "2026-10-30T10:00:00", tag="nap", goal=None)
    c = save(ada, "2026-10-30T11:00:00", tag="work", goal=None)
    path = make_feed(ada)
    by_uid = {u: e for u, e in zip(uids(ada.get(path)), events(ada.get(path)), strict=True)}
    assert str(by_uid[a]["SUMMARY"]) == TAG_NAME
    # A rename shows on the next fetch.
    ada.patch(f"/api/tags/{custom}", json={"name": "Renamed"})
    assert str(events(ada.get(path))[2]["SUMMARY"]) == "Renamed"
    # Leave out a built-in tag and a custom tag; a removed tag keeps its choice.
    ada.patch("/api/settings", json={"calendar_excluded_tags": ["nap", custom]})
    assert uids(ada.get(path)) == [c]
    ada.post(f"/api/tags/{custom}/remove")
    assert uids(ada.get(path)) == [c]
    ada.patch("/api/settings", json={"calendar_excluded_tags": ["work", "nap"]})
    assert uids(ada.get(path)) == [a]  # a removed tag keeps its name and stays in
    assert str(events(ada.get(path))[0]["SUMMARY"]) == "Renamed"
    # All unticked: an empty, valid calendar.
    ada.patch("/api/settings", json={"calendar_excluded_tags": [custom, "work", "nap"]})
    assert uids(ada.get(path)) == []
    assert b not in uids(ada.get(path))
    # A tag created later is in by default.
    new = ada.post("/api/tags", json={"name": "Later", "color": "red"}).json()["id"]
    d = save(ada, "2026-10-30T12:00:00", tag=new)
    assert uids(ada.get(path)) == [d]


def test_ac4_minimum_length_and_settings_shape_events(ada: TestClient) -> None:
    short = save(ada, "2026-10-30T09:00:00", minutes=5)
    ten = save(ada, "2026-10-30T10:00:00", minutes=10)
    long = save(ada, "2026-10-30T11:00:00", minutes=15)
    path = make_feed(ada)
    assert uids(ada.get(path)) == [long, ten, short]
    ada.patch("/api/settings", json={"calendar_min_minutes": 10})
    assert uids(ada.get(path)) == [long, ten]  # meets the minimum: 10 min counts
    ada.patch("/api/settings", json={"calendar_min_minutes": 15})
    assert uids(ada.get(path)) == [long]
    ada.patch(
        "/api/settings",
        json={
            "calendar_title_template": "{mode}: {goal}",
            "calendar_include_goal": False,
            "calendar_include_description": False,
            "calendar_name": "Deep work",
        },
    )
    r = ada.get(path)
    (event,) = events(r)
    assert str(event["SUMMARY"]) == "Countdown"
    assert "DESCRIPTION" not in event
    assert b"X-WR-CALNAME:Deep work" in r.content


def test_ac4_etag_gives_304_and_changes_with_content(ada: TestClient) -> None:
    s1 = save(ada, "2026-10-30T09:00:00", goal="One")
    path = make_feed(ada)
    first = ada.get(path)
    etag = first.headers["etag"]
    again = ada.get(path, headers={"If-None-Match": etag})
    assert again.status_code == 304
    assert again.content == b""
    assert again.headers["etag"] == etag
    assert again.headers["cache-control"] == "private, no-cache"
    assert ada.get(path, headers={"If-None-Match": etag.removeprefix("W/")}).status_code == 304
    assert ada.get(path, headers={"If-None-Match": '"nope"'}).status_code == 200
    # The same content a second later (a new DTSTAMP) keeps the ETag.
    time.sleep(1.1)
    assert ada.get(path).headers["etag"] == etag

    seen = {etag}

    def changed(label: str) -> None:
        new = ada.get(path).headers["etag"]
        assert new not in seen, label
        seen.add(new)

    s2 = save(ada, "2026-10-31T09:00:00")
    changed("a session added")
    ada.patch(f"/api/sessions/{s1}", json={"goal": "Two"})
    changed("a session edited")
    ada.post(f"/api/sessions/{s2}/archive")
    changed("a session archived")
    ada.post(f"/api/sessions/{s2}/restore")
    seen.discard(ada.get(path).headers["etag"])  # back to a state seen before is fine
    ada.patch("/api/settings", json={"calendar_name": "Renamed calendar"})
    changed("a settings change")
    tag = ada.post("/api/tags", json={"name": "Foo", "color": "red"}).json()["id"]
    ada.patch(f"/api/sessions/{s1}", json={"tag": tag})
    changed("a custom tag used")
    ada.patch(f"/api/tags/{tag}", json={"name": "Bar"})
    changed("a custom tag renamed")


def test_ac4_bad_links_are_the_same_plain_404(ada: TestClient) -> None:
    path = make_feed(ada)
    secret = path.split("/")[-1].removesuffix(".ics")
    flipped = secret[:-1] + ("A" if secret[-1] != "A" else "B")
    bodies = set()
    for bad in (
        f"/api/calendar/{flipped}.ics",
        "/api/calendar/short.ics",
        f"/api/calendar/{secret}x.ics",
        f"/api/calendar/{secret}.ics.ics",
        "/api/calendar/.ics",
        f"/api/calendar/{'!' * 43}.ics",
    ):
        r = ada.get(bad)
        assert r.status_code == 404, bad
        bodies.add(r.text)
    assert len(bodies) == 1
    assert secret not in bodies.pop()
    ada.delete("/api/calendar/feed")
    removed = ada.get(path)
    assert removed.status_code == 404
    assert removed.text == r.text


def test_ac4_last_fetched_is_updated_at_most_once_a_minute(ada: TestClient, app_url: str) -> None:
    path = make_feed(ada)
    ada.get(path)
    first = ada.get("/api/calendar/feed").json()["last_fetched_at"]
    assert first is not None
    ada.get(path)
    ada.get(path, headers={"If-None-Match": "*"})  # a 304 is a fetch too, but not within a minute
    assert ada.get("/api/calendar/feed").json()["last_fetched_at"] == first

    run(_exec(app_url, "UPDATE calendar_feeds SET last_fetched_at = now() - interval '2 minutes'"))
    ada.get(path, headers={"If-None-Match": "*"})
    after = dt.datetime.fromisoformat(ada.get("/api/calendar/feed").json()["last_fetched_at"])
    assert dt.datetime.now(dt.UTC) - after < dt.timedelta(seconds=30)


def test_ac4_rate_limits_per_client_and_for_unknown_secrets(ada: TestClient) -> None:
    path = make_feed(ada)
    ada.app.state.calendar_limiter = FailureLimiter(3, 3, 60.0)  # type: ignore[attr-defined]
    for _ in range(3):
        assert ada.get(path).status_code == 200
    limited = ada.get(path)
    assert limited.status_code == 429
    assert int(limited.headers["retry-after"]) >= 1
    assert limited.json()["error"]["code"] == "rate_limited"
    # Unknown secrets: a burst from one client is cut off, but only the failed lookups count.
    ada.app.state.calendar_limiter, ada.app.state.calendar_bad_limiter = new_limiters()  # type: ignore[attr-defined]
    ada.app.state.calendar_bad_limiter = FailureLimiter(10**9, 3, 60.0)  # type: ignore[attr-defined]
    for _ in range(10):
        assert ada.get(path).status_code == 200  # valid links never spend the budget
    guesses = [ada.get(f"/api/calendar/{'a' * 42}{i}.ics").status_code for i in range(5)]
    assert guesses == [404, 404, 404, 429, 429]
    # A client over the unknown-secret budget is still served a valid link (shared fetchers).
    assert ada.get(path).status_code == 200
    assert ada.get(path, headers={"If-None-Match": "*"}).status_code == 304
    # The general limit still applies to everything.
    ada.app.state.calendar_limiter = FailureLimiter(2, 2, 60.0)  # type: ignore[attr-defined]
    assert [ada.get(path).status_code for _ in range(3)] == [200, 200, 429]


def test_ac4_head_has_the_get_headers_and_no_body(ada: TestClient, app_url: str) -> None:
    save(ada, "2026-10-30T09:00:00")
    path = make_feed(ada)
    got = ada.get(path)
    head = ada.head(path)
    assert head.status_code == 200
    assert head.content == b""
    assert head.headers["content-type"] == got.headers["content-type"]
    assert head.headers["etag"] == got.headers["etag"]
    assert head.headers["cache-control"] == "private, no-cache"
    assert int(head.headers["content-length"]) == len(got.content)
    assert ada.head(path, headers={"If-None-Match": got.headers["etag"]}).status_code == 304
    assert ada.head(f"/api/calendar/{'a' * 43}.ics").status_code == 404


def test_ac4_head_does_not_update_last_fetched_but_counts_toward_the_limit(
    ada: TestClient,
) -> None:
    path = make_feed(ada)
    assert ada.head(path).status_code == 200
    assert ada.get("/api/calendar/feed").json()["last_fetched_at"] is None
    assert ada.get(path).status_code == 200
    assert ada.get("/api/calendar/feed").json()["last_fetched_at"] is not None
    ada.app.state.calendar_limiter = FailureLimiter(2, 2, 60.0)  # type: ignore[attr-defined]
    assert [ada.head(path).status_code for _ in range(3)] == [200, 200, 429]
    ada.app.state.calendar_limiter, _ = new_limiters()  # type: ignore[attr-defined]
    ada.app.state.calendar_bad_limiter = FailureLimiter(10**9, 1, 60.0)  # type: ignore[attr-defined]
    bad = f"/api/calendar/{'b' * 43}.ics"
    assert [ada.head(bad).status_code for _ in range(2)] == [404, 429]  # HEAD spends it too


def test_ac5_download_head_has_the_get_headers_and_no_body(ada: TestClient) -> None:
    save(ada, "2026-10-30T09:00:00")
    url = "/api/calendar/export.ics?view=all&tz=UTC"
    got = ada.get(url)
    head = ada.head(url)
    assert head.status_code == 200
    assert head.content == b""
    for name in ("content-type", "content-disposition", "cache-control"):
        assert head.headers[name] == got.headers[name]
    assert int(head.headers["content-length"]) == len(got.content)
    assert ada.head("/api/calendar/export.ics?view=all").status_code == 422


def test_ac4_ipv6_clients_in_one_64_share_a_limit(ada: TestClient) -> None:
    from app.rate_limit import client_key

    assert client_key("2001:db8::1") == client_key("2001:db8::ffff")


# --- the download (AC5) --------------------------------------------------------------------


def test_ac5_download_follows_the_history_view(ada: TestClient) -> None:
    mon = save(ada, "2026-10-26T09:00:00", tag="work")
    tue = save(ada, "2026-10-27T09:00:00", tag="study", minutes=5)
    wed = save(ada, "2026-10-28T09:00:00", tag="nap", minutes=20)
    gone = save(ada, "2026-10-28T10:00:00")
    ada.post(f"/api/sessions/{gone}/archive")
    ada.patch("/api/settings", json={"week_start_day": 1})

    r = ada.get("/api/calendar/export.ics?view=week&date=2026-10-28&tz=UTC")
    assert r.status_code == 200
    assert r.headers["content-type"] == "text/calendar; charset=utf-8"
    assert (
        r.headers["content-disposition"]
        == 'attachment; filename="ineedtofocus-2026-10-26-to-2026-11-01.ics"'
    )
    assert uids(r) == [wed, tue, mon]
    assert b"REFRESH-INTERVAL" not in r.content  # a snapshot, not a feed
    assert b"X-WR-CALNAME:I Need To Focus" in r.content

    day = ada.get("/api/calendar/export.ics?view=day&date=2026-10-27&tz=UTC")
    assert (
        'filename="ineedtofocus-2026-10-27-to-2026-10-27.ics"' in day.headers["content-disposition"]
    )
    assert uids(day) == [tue]
    custom = ada.get("/api/calendar/export.ics?view=custom&start=2026-10-27&end=2026-10-28&tz=UTC")
    assert uids(custom) == [wed, tue]
    month = ada.get("/api/calendar/export.ics?view=month&date=2026-10-05&tz=UTC")
    assert (
        'filename="ineedtofocus-2026-10-01-to-2026-10-31.ics"'
        in month.headers["content-disposition"]
    )
    all_time = ada.get("/api/calendar/export.ics?view=all&tz=UTC")
    assert all_time.headers["content-disposition"] == 'attachment; filename="ineedtofocus-all.ics"'
    assert uids(all_time) == [wed, tue, mon]

    # The History tag filter applies; the calendar's own tag setting does not.
    ada.patch("/api/settings", json={"calendar_excluded_tags": ["study", "nap"]})
    only = ada.get("/api/calendar/export.ics?view=all&tz=UTC&tag=study&tag=nap")
    assert uids(only) == [wed, tue]
    # The minimum length applies.
    ada.patch("/api/settings", json={"calendar_min_minutes": 10})
    assert uids(ada.get("/api/calendar/export.ics?view=all&tz=UTC")) == [wed, mon]


def test_ac5_days_are_local_dates(ada: TestClient) -> None:
    late = save(ada, "2026-10-27T23:30:00")  # 00:30 on the 28th in Paris
    paris = "Europe/Paris"
    assert uids(ada.get(f"/api/calendar/export.ics?view=day&date=2026-10-28&tz={paris}")) == [late]
    assert uids(ada.get(f"/api/calendar/export.ics?view=day&date=2026-10-27&tz={paris}")) == []
    assert uids(ada.get("/api/calendar/export.ics?view=day&date=2026-10-27&tz=UTC")) == [late]


@pytest.mark.parametrize(
    "query",
    [
        "view=day&tz=UTC",
        "view=day&date=2026-10-27&tz=Mars/Base",
        "view=all&date=2026-10-27&tz=UTC",
        "view=custom&start=2026-10-28&end=2026-10-27&tz=UTC",
        "view=nope&tz=UTC",
        "view=all",
        "view=all&tz=UTC&tag=Gaming",
        f"view=all&tz=UTC&tag={uuid.uuid4()}",
    ],
)
def test_ac5_download_validates_like_history(ada: TestClient, query: str) -> None:
    mine = ada.get(f"/api/calendar/export.ics?{query}")
    history = ada.get(f"/api/history?{query}")
    assert mine.status_code == history.status_code == 422
    assert mine.json() == history.json()


def test_ac5_download_has_only_my_sessions(ada: TestClient, bob: TestClient) -> None:
    save(bob, "2026-10-27T09:00:00", goal="Bob only")
    mine = save(ada, "2026-10-27T09:00:00")
    r = ada.get("/api/calendar/export.ics?view=all&tz=UTC")
    assert uids(r) == [mine]
    assert "Bob only" not in r.text


# --- account deletion (AC8) ----------------------------------------------------------------


def test_ac8_deleting_the_account_removes_the_feed(ada: TestClient, app_url: str) -> None:
    path = make_feed(ada)
    assert ada.get(path).status_code == 200
    assert ada.post("/api/account/delete", json={"password": PASSWORD}).status_code == 204
    assert ada.get(path).status_code == 404
    assert run(_query(app_url, "SELECT count(*) FROM calendar_feeds"))[0][0] == 0


# --- performance (AC4) ---------------------------------------------------------------------


def test_ac4_ten_thousand_sessions_in_under_a_second(ada: TestClient, app_url: str) -> None:
    custom = ada.post("/api/tags", json={"name": TAG_NAME, "color": "teal"}).json()["id"]
    path = make_feed(ada)

    async def seed() -> None:
        engine = create_async_engine(app_url)
        try:
            async with engine.begin() as conn:
                await conn.execute(
                    text(
                        """
                        INSERT INTO focus_sessions
                          (id, user_id, mode, tag, custom_tag_id, goal, started_at, ended_at,
                           focus_seconds, paused_seconds, status, mode_config, blocks_completed)
                        SELECT gen_random_uuid(), u.id, 'pomodoro', 'work',
                               CASE WHEN n % 2 = 0 THEN CAST(:tag AS uuid) END,
                               'Réviser le chapitre ' || n || ', puis les exercices; fin',
                               timestamptz '2026-01-01' + n * interval '30 minutes',
                               timestamptz '2026-01-01' + n * interval '30 minutes'
                                 + interval '25 minutes',
                               1500, 20, 'completed',
                               CAST(:config AS jsonb), 2
                        FROM generate_series(1, 10000) AS n, (SELECT id FROM users) AS u
                        """
                    ),
                    {"tag": custom, "config": json.dumps(POMODORO)},
                )
        finally:
            await engine.dispose()

    run(seed())
    ada.get(path)  # warm the connection pool
    timings = []
    for _ in range(3):
        started = time.perf_counter()
        r = ada.get(path)
        timings.append(time.perf_counter() - started)
        assert r.status_code == 200
    assert len(uids(r)) == 10000
    assert min(timings) < 1.0, timings


# --- privacy (AC7) -------------------------------------------------------------------------


@pytest.fixture
def traced(app_url: str) -> Iterator[tuple[TestClient, InMemorySpanExporter, io.StringIO]]:
    exporter = InMemorySpanExporter()
    provider = TracerProvider()
    assert install_privacy_filters(provider) is True
    provider.add_span_processor(SimpleSpanProcessor(exporter))
    app = create_app(Settings(database_url=app_url, cookie_secure=False), tracer_provider=provider)
    stream = io.StringIO()
    handler = logging.StreamHandler(stream)
    handler.setFormatter(JsonFormatter())
    handler.addFilter(lambda r: not r.name.startswith("httpx"))  # the test client's own log
    root = logging.getLogger()
    root.addHandler(handler)
    previous = root.level
    root.setLevel(logging.DEBUG)
    try:
        with TestClient(app, raise_server_exceptions=False) as c:
            yield c, exporter, stream
    finally:
        root.removeHandler(handler)
        root.setLevel(previous)


def test_ac7_no_secret_goal_or_custom_tag_name_in_logs_or_spans(
    traced: tuple[TestClient, InMemorySpanExporter, io.StringIO],
) -> None:
    c, exporter, stream = traced
    assert signup(c).status_code == 201
    tag = c.post("/api/tags", json={"name": TAG_NAME, "color": "teal"}).json()["id"]
    save(c, "2026-10-30T09:00:00", tag=tag, goal=GOAL)
    path = make_feed(c)
    secret = path.split("/")[-1].removesuffix(".ics")
    for_logs = [secret, token_hash(secret)]
    assert c.get(path).status_code == 200
    assert c.get(path, headers={"If-None-Match": "*"}).status_code == 304
    assert c.get(f"/api/calendar/{secret[:-1]}Z.ics?x={GOAL}").status_code == 404
    assert c.get("/api/calendar/short.ics").status_code == 404
    assert c.get("/api/calendar/export.ics?view=all&tz=UTC").status_code == 200
    assert c.get(f"/api/calendar/export.ics?view=all&tz=Nope/{GOAL}").status_code == 422
    assert c.get("/api/calendar/feed").status_code == 200
    assert c.post("/api/calendar/feed").status_code == 200
    assert c.patch("/api/settings", json={"calendar_excluded_tags": [tag]}).status_code == 200
    assert c.delete("/api/calendar/feed").status_code == 204
    c.app.state.calendar_limiter = FailureLimiter(1, 1, 60.0)  # type: ignore[attr-defined]
    c.get(path)
    assert c.get(path).status_code == 429

    spans = exporter.get_finished_spans()
    dumped = repr(
        [
            (
                s.name,
                dict(s.attributes or {}),
                [(e.name, dict(e.attributes or {})) for e in s.events],
                (s.status.status_code.name, s.status.description),
            )
            for s in spans
        ]
    )
    logs = stream.getvalue()
    secrets = [*for_logs, GOAL, "merger", "Zebrafish", "ledger"]
    for needle in secrets:
        assert needle not in dumped, needle
        assert needle not in logs, needle
    feed_spans = [
        s for s in spans if (s.attributes or {}).get("http.route") == "/api/calendar/{secret}.ics"
    ]
    assert len(feed_spans) >= 4
    for s in feed_spans:
        assert (s.attributes or {})["url.path"] == "/api/calendar/{secret}.ics"
    assert "calendar feed" in logs  # the management lines are logged, without data
    parsed = [json.loads(line) for line in logs.splitlines() if line.startswith("{")]
    assert parsed


# --- one session (AC14.7, #454) ------------------------------------------------------------


def _vevent(body: bytes) -> bytes:
    """The VEVENT block with its DTSTAMP line removed."""
    text = body.decode()
    block = text[text.index("BEGIN:VEVENT") : text.index("END:VEVENT") + len("END:VEVENT")]
    return "\r\n".join(x for x in block.split("\r\n") if not x.startswith("DTSTAMP")).encode()


def test_ac7_one_session_is_the_feed_event_with_headers(ada: TestClient) -> None:
    sid = save(ada, "2026-10-30T23:30:00", goal="Write, the; report")
    save(ada, "2026-10-30T09:00:00")
    feed = ada.get(make_feed(ada))
    r = ada.get(f"/api/calendar/session/{sid}.ics?tz=Europe/Paris")
    assert r.status_code == 200
    assert r.headers["content-type"] == "text/calendar; charset=utf-8"
    assert r.headers["content-disposition"] == (
        'inline; filename="ineedtofocus-2026-10-31-0030.ics"'  # 23:30 UTC is 00:30 in Paris
    )
    assert r.headers["cache-control"] == "private, no-store"
    assert [str(e["UID"]).split("@")[0] for e in events(r)] == [sid]
    no_stamp = b"\r\n".join(x for x in feed.content.split(b"\r\n") if not x.startswith(b"DTSTAMP"))
    assert _vevent(r.content) in no_stamp  # byte-identical to the feed's event, DTSTAMP aside
    default = ada.get(f"/api/calendar/session/{sid}.ics")
    assert 'filename="ineedtofocus-2026-10-30-2330.ics"' in default.headers["content-disposition"]


def test_ac7_one_session_applies_settings_but_not_tag_or_length_filters(ada: TestClient) -> None:
    tag = ada.post("/api/tags", json={"name": "Deep", "color": "teal"}).json()["id"]
    sid = save(ada, "2026-10-30T09:00:00", minutes=3, tag=tag, goal="Plan")
    r = ada.patch(
        "/api/settings",
        json={"calendar_min_minutes": 15, "calendar_excluded_tags": [tag]},
    )
    assert r.status_code == 200, r.text
    assert uids(ada.get(make_feed(ada))) == []
    assert uids(ada.get(f"/api/calendar/session/{sid}.ics")) == [sid]
    ada.patch(
        "/api/settings",
        json={
            "calendar_title_template": "{mode}: {goal}",
            "calendar_include_goal": False,
            "calendar_include_description": False,
        },
    )
    (event,) = events(ada.get(f"/api/calendar/session/{sid}.ics"))
    assert str(event["SUMMARY"]) == "Countdown"
    assert "DESCRIPTION" not in event


def test_ac7_one_session_needs_sign_in(make_client: MakeClient) -> None:
    sid = str(uuid.uuid4())
    with make_client() as c:
        assert c.get(f"/api/calendar/session/{sid}.ics").status_code == 401
        assert c.head(f"/api/calendar/session/{sid}.ics").status_code == 401


def test_ac7_one_session_not_yours_missing_archived_or_malformed_is_the_same_404(
    ada: TestClient, bob: TestClient
) -> None:
    mine = save(ada, "2026-10-30T09:00:00")
    archived = save(ada, "2026-10-30T10:00:00")
    assert ada.post(f"/api/sessions/{archived}/archive").status_code == 200
    answers = [
        bob.get(f"/api/calendar/session/{mine}.ics"),
        ada.get(f"/api/calendar/session/{uuid.uuid4()}.ics"),
        ada.get(f"/api/calendar/session/{archived}.ics"),
        ada.get("/api/calendar/session/not-a-uuid.ics"),
    ]
    assert {(r.status_code, r.text) for r in answers} == {(404, answers[0].text)}
    assert "Not Found" in answers[0].text


def test_ac7_one_session_validates_tz_and_supports_head(ada: TestClient) -> None:
    sid = save(ada, "2026-10-30T09:00:00")
    url = f"/api/calendar/session/{sid}.ics"
    assert ada.get(f"{url}?tz=Nope/Zone").status_code == 422
    got = ada.get(url)
    head = ada.head(url)
    assert head.status_code == 200
    assert head.content == b""
    for name in ("content-type", "content-disposition", "cache-control"):
        assert head.headers[name] == got.headers[name]
    assert int(head.headers["content-length"]) == len(got.content)


def test_ac7_one_session_keeps_goal_tag_and_id_out_of_logs_and_spans(
    traced: tuple[TestClient, InMemorySpanExporter, io.StringIO],
) -> None:
    c, exporter, stream = traced
    assert signup(c).status_code == 201
    tag = c.post("/api/tags", json={"name": TAG_NAME, "color": "teal"}).json()["id"]
    sid = save(c, "2026-10-30T09:00:00", tag=tag, goal=GOAL)
    assert c.get(f"/api/calendar/session/{sid}.ics").status_code == 200
    assert c.head(f"/api/calendar/session/{sid}.ics").status_code == 200
    assert c.get(f"/api/calendar/session/{uuid.uuid4()}.ics?x={GOAL}").status_code == 404
    spans = exporter.get_finished_spans()
    dumped = repr([(s.name, dict(s.attributes or {})) for s in spans])
    logs = stream.getvalue()
    for needle in (sid, GOAL, "merger", "Zebrafish", "ledger"):
        assert needle not in dumped, needle
        assert needle not in logs, needle
    route = "/api/calendar/session/{session_id}.ics"
    routed = [s for s in spans if (s.attributes or {}).get("http.route") == route]
    assert len(routed) >= 3
    for s in routed:
        assert (s.attributes or {})["url.path"] == route
