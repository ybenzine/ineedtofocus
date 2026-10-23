"""Settings API and recent YouTube links (#12) against a real, migrated Postgres."""

import logging
from collections.abc import Iterator
from typing import Any

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import text
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import create_async_engine

from app.logging_config import configure_logging
from tests.integration.conftest import run
from tests.integration.test_auth import MakeClient, signup
from tests.integration.test_auth import make_client as make_client

pytestmark = pytest.mark.integration

DEFAULTS = {
    "week_start_day": 0,
    "alert_volume": 80,
    "background_volume": 50,
    "keep_screen_awake": False,
    "default_reminder_minutes": None,
    "pomodoro_config": None,
    "last_tag": None,
}
POMODORO = {
    "focus_minutes": 50,
    "break_minutes": 10,
    "blocks": 3,
    "long_break_enabled": True,
    "long_break_minutes": 20,
}


def link(n: int) -> str:
    return f"https://www.youtube.com/watch?v=secret{n:04d}"


@pytest.fixture
def client(make_client: MakeClient) -> Iterator[TestClient]:
    with make_client() as c:
        signup(c)
        yield c


def body(c: TestClient) -> dict[str, Any]:
    out: dict[str, Any] = c.get("/api/settings").json()
    out.pop("updated_at")
    return out


async def _exec(url: str, sql: str) -> None:
    engine = create_async_engine(url)
    try:
        async with engine.begin() as conn:
            await conn.execute(text(sql))
    finally:
        await engine.dispose()


async def _scalar(url: str, sql: str) -> list[Any]:
    engine = create_async_engine(url)
    try:
        async with engine.connect() as conn:
            return list((await conn.execute(text(sql))).all())
    finally:
        await engine.dispose()


def test_signed_out_requests_get_401(make_client: MakeClient) -> None:
    with make_client() as c:
        for method, path in [
            ("GET", "/api/settings"),
            ("PATCH", "/api/settings"),
            ("GET", "/api/youtube-links"),
            ("POST", "/api/youtube-links"),
        ]:
            r = c.request(method, path, json={})
            assert r.status_code == 401, (method, path)
            assert r.json()["error"]["code"] == "unauthorized"


def test_new_user_gets_the_defaults(client: TestClient) -> None:
    """Decision log (#6): alert 80, background 50, keep-awake off, Sunday, no tag = Work."""
    assert body(client) == DEFAULTS


def test_ac12_1_to_12_4_round_trip(client: TestClient) -> None:
    patch = {
        "week_start_day": 1,
        "alert_volume": 0,
        "background_volume": 100,
        "keep_screen_awake": True,
        "default_reminder_minutes": 45,
    }
    r = client.patch("/api/settings", json=patch)
    assert r.status_code == 200
    assert body(client) == {**DEFAULTS, **patch}
    r = client.patch("/api/settings", json={"default_reminder_minutes": None})  # Off
    assert r.json()["default_reminder_minutes"] is None


def test_partial_update_leaves_other_fields_alone(client: TestClient) -> None:
    client.patch("/api/settings", json={"alert_volume": 10, "last_tag": "study"})
    client.patch("/api/settings", json={"background_volume": 20})
    assert body(client) == {
        **DEFAULTS,
        "alert_volume": 10,
        "background_volume": 20,
        "last_tag": "study",
    }
    assert client.patch("/api/settings", json={}).status_code == 200


def test_updated_at_moves_on_update(client: TestClient) -> None:
    before = client.get("/api/settings").json()["updated_at"]
    after = client.patch("/api/settings", json={"alert_volume": 1}).json()["updated_at"]
    assert after > before


@pytest.mark.parametrize(
    "patch",
    [
        {"week_start_day": 7},
        {"week_start_day": -1},
        {"alert_volume": 101},
        {"alert_volume": -1},
        {"background_volume": 101},
        {"alert_volume": 50.5},
        {"alert_volume": "50"},
        {"alert_volume": None},
        {"keep_screen_awake": "yes"},
        {"keep_screen_awake": None},
        {"default_reminder_minutes": 20},
        {"default_reminder_minutes": 0},
        {"unknown": 1},
    ],
)
def test_out_of_range_settings_are_422_and_change_nothing(
    client: TestClient, patch: dict[str, Any]
) -> None:
    r = client.patch("/api/settings", json=patch)
    assert r.status_code == 422
    assert r.json()["error"]["code"] == "validation_error"
    assert body(client) == DEFAULTS


def test_ac12_5_pomodoro_config_and_tag_round_trip(client: TestClient) -> None:
    r = client.patch("/api/settings", json={"pomodoro_config": POMODORO, "last_tag": "meditation"})
    assert r.status_code == 200
    assert r.json()["pomodoro_config"] == POMODORO
    assert r.json()["last_tag"] == "meditation"
    assert body(client)["pomodoro_config"] == POMODORO
    # A config with the long break off keeps its remembered long-break length.
    off = {**POMODORO, "long_break_enabled": False}
    r = client.patch("/api/settings", json={"pomodoro_config": off})
    assert r.json()["pomodoro_config"] == off


@pytest.mark.parametrize("tag", ["work", "study", "nap", "read", "meditation", "exercise"])
def test_ac12_5_every_tag_is_accepted(client: TestClient, tag: str) -> None:
    assert client.patch("/api/settings", json={"last_tag": tag}).json()["last_tag"] == tag


def test_ac12_5_null_tag_comes_back_null(client: TestClient) -> None:
    assert client.get("/api/settings").json()["last_tag"] is None
    client.patch("/api/settings", json={"last_tag": "nap"})
    assert client.patch("/api/settings", json={"last_tag": None}).json()["last_tag"] is None
    assert client.get("/api/settings").json()["last_tag"] is None


@pytest.mark.parametrize("tag", ["Work", "gaming", "", 3])
def test_ac12_5_unknown_tag_is_422(client: TestClient, tag: Any) -> None:
    assert client.patch("/api/settings", json={"last_tag": tag}).status_code == 422
    assert body(client)["last_tag"] is None


@pytest.mark.parametrize(
    ("field", "good", "bad"),
    [
        ("focus_minutes", [5, 90], [4, 91, 0, 25.5, "25"]),
        ("break_minutes", [1, 30], [0, 31]),
        ("blocks", [1, 8], [0, 9]),
        ("long_break_minutes", [5, 60], [4, 61]),
    ],
)
def test_ac12_5_pomodoro_ranges_follow_ac3_2(
    client: TestClient, field: str, good: list[Any], bad: list[Any]
) -> None:
    for value in good:
        r = client.patch("/api/settings", json={"pomodoro_config": {**POMODORO, field: value}})
        assert r.status_code == 200, (field, value)
    for value in bad:
        r = client.patch("/api/settings", json={"pomodoro_config": {**POMODORO, field: value}})
        assert r.status_code == 422, (field, value)
        assert r.json()["error"]["details"][0]["field"] == f"pomodoro_config.{field}"
    assert body(client)["pomodoro_config"] == {**POMODORO, field: good[-1]}


def test_ac12_5_incomplete_or_malformed_pomodoro_config_is_422(client: TestClient) -> None:
    missing = {k: v for k, v in POMODORO.items() if k != "blocks"}
    wrong_flag = {**POMODORO, "long_break_enabled": 1}
    for config in (missing, {**POMODORO, "mode": "pomodoro"}, wrong_flag):
        r = client.patch("/api/settings", json={"pomodoro_config": config})
        assert r.status_code == 422
    assert body(client)["pomodoro_config"] is None


def test_settings_are_per_user(make_client: MakeClient) -> None:
    with make_client() as a, make_client() as b:
        signup(a, "a@example.com")
        signup(b, "b@example.com")
        a.patch(
            "/api/settings",
            json={"alert_volume": 5, "last_tag": "read", "pomodoro_config": POMODORO},
        )
        assert body(b) == DEFAULTS
        b.patch("/api/settings", json={"alert_volume": 99})
        assert body(a)["alert_volume"] == 5
        assert body(a)["pomodoro_config"] == POMODORO
        assert body(a)["last_tag"] == "read"


def test_missing_settings_row_is_created_with_defaults(
    client: TestClient, test_db_url: str
) -> None:
    run(_exec(test_db_url, "DELETE FROM user_settings"))
    assert body(client) == DEFAULTS
    run(_exec(test_db_url, "DELETE FROM user_settings"))
    assert client.patch("/api/settings", json={"alert_volume": 3}).json()["alert_volume"] == 3


# --- recent YouTube links (AC8.6) ---


def use(c: TestClient, url: str) -> Any:
    return c.post("/api/youtube-links", json={"url": url})


def urls(c: TestClient) -> list[str]:
    return [item["url"] for item in c.get("/api/youtube-links").json()["links"]]


def test_ac8_6_no_links_for_a_new_user(client: TestClient) -> None:
    assert client.get("/api/youtube-links").json() == {"links": []}


def test_ac8_6_keeps_the_five_most_recent_newest_first(client: TestClient) -> None:
    for n in range(7):
        assert use(client, link(n)).status_code == 200
    assert urls(client) == [link(n) for n in (6, 5, 4, 3, 2)]
    assert use(client, link(7)).json()["links"][0]["url"] == link(7)
    assert len(urls(client)) == 5


def test_ac8_6_reusing_a_link_moves_it_to_the_top_without_duplicating(
    client: TestClient,
) -> None:
    for n in range(3):
        use(client, link(n))
    assert [x["url"] for x in use(client, link(0)).json()["links"]] == [link(0), link(2), link(1)]
    assert urls(client) == [link(0), link(2), link(1)]


def test_ac8_6_reusing_an_old_link_does_not_evict_the_others(client: TestClient) -> None:
    for n in range(5):
        use(client, link(n))
    use(client, link(0))
    assert urls(client) == [link(0), link(4), link(3), link(2), link(1)]


def test_ac8_6_links_are_per_user(make_client: MakeClient) -> None:
    with make_client() as a, make_client() as b:
        signup(a, "a@example.com")
        signup(b, "b@example.com")
        for n in range(6):
            use(a, link(n))
        assert urls(b) == []
        use(b, link(0))  # the same URL for another user is its own row
        assert urls(b) == [link(0)]
        assert len(urls(a)) == 5 and link(0) not in urls(a)  # a's 6th evicted a's own first


@pytest.mark.parametrize(
    "url",
    [
        "https://youtu.be/dQw4w9WgXcQ",
        "http://youtube.com/watch?v=abc",
        "https://m.youtube.com/watch?v=abc",
        "https://music.youtube.com/watch?v=abc",
        "https://www.youtube-nocookie.com/embed/abc",
        "  https://www.youtube.com/watch?v=abc  ",
    ],
)
def test_ac8_6_accepts_youtube_links(client: TestClient, url: str) -> None:
    assert use(client, url).status_code == 200
    assert urls(client) == [url.strip()]


@pytest.mark.parametrize(
    "url",
    [
        "",
        "not a url",
        "https://example.com/watch?v=abc",
        "https://youtube.com.evil.example/watch",
        "https://evil.example/?u=https://youtube.com/x",
        "javascript:alert(1)//youtube.com",
        "ftp://youtube.com/x",
        "https://[bad",
        pytest.param("https://www.youtube.com/" + "a" * 2048, id="too-long"),
    ],
)
def test_ac8_6_rejects_other_links_without_echoing_them(client: TestClient, url: str) -> None:
    r = use(client, url)
    assert r.status_code == 422
    assert r.json()["error"]["code"] == "validation_error"
    assert not url or url not in r.text
    assert urls(client) == []


def test_ac8_6_missing_or_extra_fields_are_422(client: TestClient) -> None:
    assert client.post("/api/youtube-links", json={}).status_code == 422
    assert client.post("/api/youtube-links", json={"url": link(1), "x": 1}).status_code == 422


# --- telemetry privacy ---


def test_no_youtube_link_in_logs_on_request_or_database_error(
    client: TestClient, test_db_url: str, capsys: pytest.CaptureFixture[str]
) -> None:
    """Accepted and rejected links stay out of logs, and so does the text of a real
    database error raised while storing one (unique violation with bound parameters)."""
    configure_logging("DEBUG")
    use(client, link(1))
    use(client, "https://example.com/" + link(2))
    uid = run(_scalar(test_db_url, "SELECT id FROM users"))[0][0]
    dup = f"INSERT INTO youtube_recent_links (user_id, url) VALUES ('{uid}', :u)"

    async def violate() -> BaseException:
        engine = create_async_engine(test_db_url)
        try:
            async with engine.connect() as conn:
                await conn.execute(text(dup), {"u": link(1)})
        except IntegrityError as exc:
            return exc
        finally:
            await engine.dispose()
        raise AssertionError("expected a unique violation")

    exc = run(violate())
    assert "secret0001" in str(exc)  # the raw error does carry the link ...
    logging.getLogger("app.errors").error("unhandled exception", exc_info=exc)
    out = capsys.readouterr().out
    assert "unhandled exception" in out and "IntegrityError" in out
    assert "secret000" not in out and "youtube.com" not in out  # ... the log does not
