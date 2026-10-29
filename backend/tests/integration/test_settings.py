"""Settings API and recent YouTube links (#12) against a real, migrated Postgres."""

import asyncio
import json
import logging
from collections.abc import Iterator
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from typing import Any

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import text
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import create_async_engine

from app import settings_api
from app.logging_config import configure_logging
from tests.integration.conftest import MakeClient, run, signup

pytestmark = pytest.mark.integration

DEFAULTS = {
    "week_start_day": 0,
    "alert_volume": 80,
    "background_volume": 50,
    "keep_screen_awake": False,
    "default_reminder_minutes": None,
    "pomodoro_config": None,
    "last_tag": None,
    "theme": "system",
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
        "theme": "light",
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
        {"theme": "sepia"},
        {"theme": None},
        {"theme": "Dark"},
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


ID = "dQw4w9WgXcQ"
PLAYLIST = "PLrAXtmErZgOeiKm4sgNOknGvNjby9efdf"
# Every way of writing one video (#249): short link, hosts, scheme, extra parameters.
SAME_VIDEO = [
    f"https://www.youtube.com/watch?v={ID}",
    f"https://youtu.be/{ID}",
    f"https://youtu.be/{ID}?t=30&si=abc",
    f"http://youtube.com/watch?v={ID}",
    f"https://m.youtube.com/watch?v={ID}&feature=share",
    f"https://music.youtube.com/watch?si=x&v={ID}",
    f"https://www.youtube-nocookie.com/embed/{ID}",
    f"https://www.youtube.com/shorts/{ID}",
    f"https://www.youtube.com/watch?v={ID}&list={PLAYLIST}",
    f"https://www.youtube.com/watch?v={ID}#t=5",
]


@pytest.mark.parametrize("variant", SAME_VIDEO[1:])
def test_ac_249_variant_forms_of_one_video_are_one_entry(client: TestClient, variant: str) -> None:
    use(client, SAME_VIDEO[0])
    body_ = use(client, variant).json()
    assert [x["url"] for x in body_["links"]] == [variant]  # the URL just used is stored
    assert urls(client) == [variant]


def test_ac_249_repasting_a_variant_moves_it_to_the_top(client: TestClient) -> None:
    use(client, SAME_VIDEO[0])
    use(client, link(1))
    use(client, link(2))
    use(client, f"https://youtu.be/{ID}?t=9")
    assert urls(client) == [f"https://youtu.be/{ID}?t=9", link(2), link(1)]


def test_ac_249_a_video_in_a_playlist_is_keyed_as_the_video(client: TestClient) -> None:
    """The player plays the video id when a link has both, so the video is the identity."""
    playlist = f"https://www.youtube.com/playlist?list={PLAYLIST}"
    both = f"https://www.youtube.com/watch?v={ID}&list={PLAYLIST}"
    use(client, playlist)
    use(client, both)  # not the playlist's entry: a different thing is played
    assert urls(client) == [both, playlist]
    use(client, f"https://www.youtube.com/embed/videoseries?list={PLAYLIST}")
    assert urls(client) == [f"https://www.youtube.com/embed/videoseries?list={PLAYLIST}", both]


def test_ac_249_limit_of_five_counts_ids_not_urls(client: TestClient) -> None:
    for n in range(4):
        use(client, link(n))
    for variant in SAME_VIDEO:
        use(client, variant)
    assert urls(client) == [SAME_VIDEO[-1], link(3), link(2), link(1), link(0)]
    use(client, link(9))
    assert len(urls(client)) == 5 and link(0) not in urls(client)


def test_ac_249_rows_that_are_already_duplicated_collapse(
    client: TestClient, test_db_url: str
) -> None:
    uid = run(_scalar(test_db_url, "SELECT id FROM users"))[0][0]
    rows = [
        (f"https://www.youtube.com/watch?v={ID}", 1),
        (link(1), 2),
        (f"https://youtu.be/{ID}", 3),
        (f"https://m.youtube.com/watch?v={ID}&t=1", 4),
        (link(2), 5),
    ]
    for url, minute in rows:
        run(
            _exec(
                test_db_url,
                f"INSERT INTO youtube_recent_links (user_id, url, last_used_at) VALUES "
                f"('{uid}', '{url}', now() - interval '{10 - minute} minutes')",
            )
        )
    # The newest of the duplicates stands for the id, in its place in the order.
    expected = [link(2), f"https://m.youtube.com/watch?v={ID}&t=1", link(1)]
    assert urls(client) == expected
    use(client, link(3))  # a write cleans the table too
    assert urls(client) == [link(3), *expected]
    left = run(_scalar(test_db_url, "SELECT count(*) FROM youtube_recent_links"))[0][0]
    assert left == 4


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
        "https://www.youtube.com/shorts/abc123",
        "https://www.youtube.com/playlist?list=PLabc",
        "https://www.youtube.com/live/abc123",
        "https://www.youtube.com/embed/abc123",
        "https://www.youtube.com:443/watch?v=abc",
        "http://youtube.com:80/watch?v=abc",
        "HTTPS://WWW.YOUTUBE.COM/watch?v=abc",
        "Https://YouTu.be/abc",
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
        "https://evil.example\\@youtube.com/x",
        "https://www.youtube.com\\@evil.example/x",
        "https://user:pass@youtube.com/watch?v=abc",
        "https://user@www.youtube.com/watch?v=abc",
        "https://@youtube.com/watch?v=abc",
        "https://www.youtube.com:8080/watch?v=abc",
        "https://www.youtube.com:80/watch?v=abc",
        "https://www.youtube.com:443x/watch?v=abc",
        "https://www.youtube.com/watch?v=a bc",
        "https://www.youtube.com/watch?v=a\tbc",
        "https://www.youtube.com/watch?v=a\nbc",
        "https://www.youtube.com/wat\x00ch",
        "https://www.youtube.com/watch?v=a\u200bbc",
        "https://www.youtube.com/watch?v=a\u00a0bc",
        "https://www.youtu\u212aube.com/watch",
        "https://www.youtube-nocoo\u212aie.com/embed/x",
        "https://www.youtube.com\u3002evil.example/x",
        "https://www.y\u00f6utube.com/watch",
        pytest.param("https://www.youtube.com/" + "a" * 2048, id="too-long"),
    ],
)
def test_ac8_6_rejects_other_links_without_echoing_them(client: TestClient, url: str) -> None:
    r = use(client, url)
    assert r.status_code == 422
    assert r.json()["error"]["code"] == "validation_error"
    assert not url or url not in r.text
    assert urls(client) == []


# --- titles (#326) ---


def titles(c: TestClient) -> list[str | None]:
    return [item["title"] for item in c.get("/api/youtube-links").json()["links"]]


def use_titled(c: TestClient, url: str, title: Any) -> Any:
    return c.post("/api/youtube-links", json={"url": url, "title": title})


def test_326_a_link_has_no_title_until_one_is_sent(client: TestClient) -> None:
    assert use(client, link(1)).json()["links"][0]["title"] is None


def test_326_the_title_is_saved_and_listed(client: TestClient) -> None:
    r = use_titled(client, link(1), "  Rain on a tin roof  ")
    assert r.status_code == 200
    assert r.json()["links"][0]["title"] == "Rain on a tin roof"
    assert titles(client) == ["Rain on a tin roof"]


def test_326_reposting_without_a_title_keeps_the_known_one(client: TestClient) -> None:
    use_titled(client, link(1), "Known title")
    use(client, link(1))
    use_titled(client, link(1), None)
    use_titled(client, link(1), "   ")
    assert titles(client) == ["Known title"]


def test_326_reposting_with_a_title_replaces_it(client: TestClient) -> None:
    use_titled(client, link(1), "Old")
    use_titled(client, link(1), "New")
    assert titles(client) == ["New"]


def test_326_the_title_follows_the_same_video_under_another_url(client: TestClient) -> None:
    use_titled(client, f"https://www.youtube.com/watch?v={ID}", "Same video")
    use(client, f"https://youtu.be/{ID}")
    assert urls(client) == [f"https://youtu.be/{ID}"]
    assert titles(client) == ["Same video"]


def test_326_titles_are_per_user(make_client: MakeClient) -> None:
    with make_client() as a, make_client() as b:
        signup(a, "a@example.com")
        signup(b, "b@example.com")
        use_titled(a, link(1), "Mine")
        use_titled(b, link(1), None)
        assert titles(a) == ["Mine"]
        assert titles(b) == [None]


def test_326_a_title_of_200_characters_is_accepted(client: TestClient) -> None:
    assert use_titled(client, link(1), "é" * 200).status_code == 200
    assert titles(client) == ["é" * 200]


def test_326_a_longer_title_is_refused_without_echoing_it(client: TestClient) -> None:
    title = "secrettitle" * 19
    r = use_titled(client, link(1), title)
    assert r.status_code == 422
    assert r.json()["error"]["code"] == "validation_error"
    assert "secrettitle" not in r.text
    assert urls(client) == []


def test_326_a_title_of_the_wrong_type_is_refused_without_echoing_it(
    client: TestClient,
) -> None:
    r = use_titled(client, link(1), {"x": "secrettitle"})
    assert r.status_code == 422
    assert "secrettitle" not in r.text


@pytest.mark.parametrize("bad", ["badz\x00title", "badz\ud800title"], ids=["nul", "lone-surrogate"])
def test_326_a_title_postgres_cannot_store_is_422_without_echoing_it(
    client: TestClient, bad: str
) -> None:
    body = json.dumps({"url": link(1), "title": bad})  # ASCII escapes keep the surrogate
    r = client.post(
        "/api/youtube-links", content=body, headers={"Content-Type": "application/json"}
    )
    assert r.status_code == 422
    assert "badz" not in r.text
    assert urls(client) == []


# One list of cases shared with the client check (frontend/src/sounds/youtubeLink.test.ts).
# `server_ok` is what the server says about `url` as written (null: depends on the Unicode version
# of the Python in use, so not asserted); `sent` is what the client posts when it accepts the link.
_FIXTURE = json.loads(
    (Path(__file__).resolve().parents[3] / "_docs/api/fixtures/youtube-links.json").read_text()
)


@pytest.mark.parametrize(
    "case",
    [pytest.param(c, id=c["reason"]) for c in _FIXTURE if c["server_ok"] is not None],
)
def test_ac8_6_shared_fixture_server_verdict(client: TestClient, case: dict[str, Any]) -> None:
    assert use(client, case["url"]).status_code == (200 if case["server_ok"] else 422)


@pytest.mark.parametrize(
    "case", [pytest.param(c, id=c["reason"]) for c in _FIXTURE if c["client_ok"]]
)
def test_ac_249_server_key_matches_the_client_parse(case: dict[str, Any]) -> None:
    # `key` is the id the client's parse finds (youtubeLink.test.ts checks the same value).
    assert settings_api.youtube_key(case["sent"]) == case["key"]


@pytest.mark.parametrize(
    "case",
    [pytest.param(c, id=c["reason"]) for c in _FIXTURE if c["client_ok"]],
)
def test_ac8_6_server_saves_every_link_the_client_plays(
    client: TestClient, case: dict[str, Any]
) -> None:
    # Includes the characters Python's older Unicode tables call unassigned: sent encoded.
    assert case["sent"].isascii()
    assert use(client, case["sent"]).status_code == 200
    assert urls(client) == [case["sent"]]


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


def test_first_gets_for_a_new_user_race_to_one_row(
    make_client: MakeClient, test_db_url: str, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Two concurrent first GETs both succeed and leave a single settings row.

    A barrier inside `_get_or_create` holds each request until both are in it, so the two
    really overlap (a select-then-insert implementation fails this with an IntegrityError).
    """
    real = settings_api._get_or_create
    barrier: asyncio.Barrier | None = None

    async def gated(db: Any, user: Any) -> Any:
        nonlocal barrier
        barrier = barrier or asyncio.Barrier(2)
        async with asyncio.timeout(5):
            await barrier.wait()
        return await real(db, user)

    monkeypatch.setattr(settings_api, "_get_or_create", gated)
    with make_client() as c:
        assert signup(c).status_code == 201
        run(_exec(test_db_url, "DELETE FROM user_settings"))  # as if sign-up had not made one
        with ThreadPoolExecutor(max_workers=2) as pool:
            futures = [pool.submit(c.get, "/api/settings") for _ in range(2)]
            codes = [f.result().status_code for f in futures]
    assert codes == [200, 200]
    assert run(_scalar(test_db_url, "SELECT count(*) FROM user_settings"))[0][0] == 1


@pytest.mark.parametrize(
    "text_link",
    [
        "https://www.youtube.com/@channel",
        "https://www.youtube.com/results?search_query=rain",
        "https://youtu.be/",
    ],
)
def test_ac_249_a_link_with_no_id_is_keyed_by_its_text(client: TestClient, text_link: str) -> None:
    """The server accepts links the client can't play; those are keyed `url:<text>`."""
    assert settings_api.youtube_key(text_link) == f"url:{text_link}"
    assert settings_api.youtube_key(f"  {text_link} ") == f"url:{text_link}"  # trimmed
    use(client, text_link)
    use(client, link(1))
    use(client, text_link)  # identical text: one entry, moved to the top
    assert urls(client) == [text_link, link(1)]
    use(client, text_link + "&x=1" if "?" in text_link else text_link + "?x=1")  # other text
    assert len(urls(client)) == 3


def test_ac_249_concurrent_pastes_of_one_id_leave_one_row(
    client: TestClient, test_db_url: str
) -> None:
    """Two (here eight) simultaneous POSTs for one user end with one row per key, no 500."""
    variants = [SAME_VIDEO[i % len(SAME_VIDEO)] for i in range(8)] + [link(1), link(1)]
    with ThreadPoolExecutor(max_workers=8) as pool:
        codes = [f.result().status_code for f in [pool.submit(use, client, v) for v in variants]]
    assert codes == [200] * len(variants)
    assert run(_scalar(test_db_url, "SELECT count(*) FROM youtube_recent_links"))[0][0] == 2
    assert len(urls(client)) == 2
