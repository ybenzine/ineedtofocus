"""Sessions API (#10) against a real, migrated, throwaway Postgres."""

import uuid
from collections.abc import Iterator
from concurrent.futures import ThreadPoolExecutor
from typing import Any

import pytest
from alembic import command
from alembic.config import Config
from fastapi.testclient import TestClient
from httpx import Response
from sqlalchemy import text
from sqlalchemy.exc import DBAPIError
from sqlalchemy.ext.asyncio import AsyncEngine, create_async_engine

from app.config import Settings
from app.logging_config import scrub
from app.main import create_app
from app.models import FocusSession
from app.sessions import SessionIn
from tests.integration.conftest import run

pytestmark = pytest.mark.integration

PASSWORD = "correct horse battery"


def make_session(**over: Any) -> dict[str, Any]:
    body: dict[str, Any] = {
        "id": str(uuid.uuid4()),
        "mode": "countdown",
        "tag": "work",
        "goal": "Write the report",
        "started_at": "2026-10-23T09:00:00Z",
        "ended_at": "2026-10-23T09:25:30Z",
        "focus_seconds": 1500,
        "paused_seconds": 30,
        "status": "completed",
        "mode_config": {"mode": "countdown", "minutes": 25},
        "blocks_completed": 0,
    }
    body.update(over)
    return body


POMODORO_CONFIG = {
    "mode": "pomodoro",
    "focus_minutes": 25,
    "break_minutes": 5,
    "blocks": 4,
    "long_break_enabled": False,
    "long_break_minutes": 15,
}


@pytest.fixture
def app_url(alembic_config: Config, test_db_url: str) -> str:
    command.upgrade(alembic_config, "head")
    return test_db_url


@pytest.fixture
def ada(app_url: str) -> Iterator[TestClient]:
    # One app (and event loop) per client; both talk to the same database.
    settings = Settings(database_url=app_url, cookie_secure=False)
    with TestClient(create_app(settings)) as c, TestClient(create_app(settings)) as bob:
        assert _signup(c, "ada@example.com").status_code == 201
        assert _signup(bob, "bob@example.com").status_code == 201
        c.bob = bob
        yield c


@pytest.fixture
def bob(ada: TestClient) -> TestClient:
    client: TestClient = ada.bob
    return client


def _signup(c: TestClient, email: str) -> Response:
    r: Response = c.post("/api/auth/signup", json={"email": email, "password": PASSWORD})
    return r


async def _query(url: str, sql: str) -> list[Any]:
    engine: AsyncEngine = create_async_engine(url)
    try:
        async with engine.connect() as conn:
            return list((await conn.execute(text(sql))).all())
    finally:
        await engine.dispose()


def count(url: str) -> int:
    return int(run(_query(url, "SELECT count(*) FROM focus_sessions"))[0][0])


def save(c: TestClient, **over: Any) -> dict[str, Any]:
    r = c.post("/api/sessions", json=make_session(**over))
    assert r.status_code == 201, r.text
    body: dict[str, Any] = r.json()
    return body


# --- save, idempotency, validation -------------------------------------------------------


def test_save_one_session_returns_it(ada: TestClient) -> None:
    body = make_session(mode="pomodoro", mode_config=POMODORO_CONFIG, blocks_completed=2)
    r = ada.post("/api/sessions", json=body)
    assert r.status_code == 201
    out = r.json()
    assert out["id"] == body["id"]
    assert out["mode_config"] == POMODORO_CONFIG
    assert out["blocks_completed"] == 2
    assert out["archived_at"] is None
    assert out["started_at"].startswith("2026-10-23T09:00:00")


def test_ac13_4_repeating_a_save_never_duplicates(ada: TestClient, app_url: str) -> None:
    body = make_session()
    assert ada.post("/api/sessions", json=body).status_code == 201
    again = ada.post("/api/sessions", json={**body, "tag": "study"})
    assert again.status_code == 200
    assert again.json()["tag"] == "work"  # the first write stands
    assert count(app_url) == 1


def test_ac13_4_concurrent_retries_create_one_row(ada: TestClient, app_url: str) -> None:
    body = make_session()
    with ThreadPoolExecutor(8) as pool:
        codes = list(pool.map(lambda _: ada.post("/api/sessions", json=body).status_code, range(8)))
    assert sorted(set(codes)) in ([200, 201], [201])
    assert codes.count(201) == 1
    assert count(app_url) == 1


def test_ac13_4_batch_sync_is_idempotent(ada: TestClient, app_url: str) -> None:
    batch = [make_session() for _ in range(3)]
    r = ada.post("/api/sessions/sync", json={"sessions": batch})
    assert r.status_code == 200
    assert (r.json()["created"], r.json()["existing"]) == (3, 0)
    assert [s["id"] for s in r.json()["sessions"]] == [s["id"] for s in batch]

    extra = make_session()
    r = ada.post("/api/sessions/sync", json={"sessions": [*batch, extra, extra]})
    assert (r.json()["created"], r.json()["existing"]) == (1, 3)
    assert len(r.json()["sessions"]) == 5
    assert count(app_url) == 4


def test_batch_with_one_invalid_session_saves_nothing(ada: TestClient, app_url: str) -> None:
    batch = [make_session(), make_session(), make_session(focus_seconds=59)]
    r = ada.post("/api/sessions/sync", json={"sessions": batch})
    assert r.status_code == 422
    assert r.json()["error"]["details"][0]["field"] == "sessions.2.focus_seconds"
    assert count(app_url) == 0


def test_batch_limits(ada: TestClient) -> None:
    assert ada.post("/api/sessions/sync", json={"sessions": []}).status_code == 422
    too_many = [make_session() for _ in range(101)]
    assert ada.post("/api/sessions/sync", json={"sessions": too_many}).status_code == 422


def test_ac6_2_under_one_minute_is_rejected(ada: TestClient, app_url: str) -> None:
    r = ada.post("/api/sessions", json=make_session(focus_seconds=59))
    assert r.status_code == 422
    detail = r.json()["error"]["details"][0]
    assert detail["field"] == "focus_seconds"
    assert "1 minute" in detail["message"]
    assert count(app_url) == 0
    assert ada.post("/api/sessions", json=make_session(focus_seconds=60)).status_code == 201


@pytest.mark.parametrize(
    ("override", "field"),
    [
        ({"mode": "stopwatch"}, "mode"),
        ({"tag": "gaming"}, "tag"),
        ({"tag": "Work"}, "tag"),
        ({"status": "paused"}, "status"),
        ({"goal": "x" * 121}, "goal"),
        ({"focus_seconds": 12 * 3600 + 1, "ended_at": "2026-10-24T09:00:00Z"}, "focus_seconds"),
        ({"paused_seconds": -1}, "paused_seconds"),
        ({"id": "not-a-uuid"}, "id"),
        ({"started_at": "2026-10-23T09:00:00"}, "started_at"),  # no time zone
        ({"ended_at": "2026-10-23T08:00:00Z"}, ""),  # before start
        ({"ended_at": "2026-10-23T09:10:00Z"}, ""),  # less time than focus + paused
        ({"mode_config": {"mode": "countdown", "minutes": 241}}, "mode_config.countdown.minutes"),
        ({"mode_config": {"mode": "countdown", "minutes": 0}}, "mode_config.countdown.minutes"),
        ({"mode_config": {"mode": "unlimited", "reminder_minutes": None}}, ""),  # mode mismatch
        ({"mode_config": {"mode": "countdown", "minutes": 25, "x": 1}}, "mode_config.countdown.x"),
        ({"blocks_completed": 1}, ""),  # countdown has no blocks
        ({"unknown": 1}, "<unknown>"),
    ],
)
def test_invalid_sessions_are_rejected(
    ada: TestClient, app_url: str, override: dict[str, Any], field: str
) -> None:
    r = ada.post("/api/sessions", json=make_session(**override))
    assert r.status_code == 422, r.text
    assert r.json()["error"]["code"] == "validation_error"
    fields = [d["field"] for d in r.json()["error"]["details"]]
    if field and field != "<unknown>":
        assert any(f.split(".")[0] == field.split(".")[0] for f in fields), fields
    assert count(app_url) == 0


@pytest.mark.parametrize(
    "config",
    [
        {**POMODORO_CONFIG, "focus_minutes": 4},
        {**POMODORO_CONFIG, "focus_minutes": 91},
        {**POMODORO_CONFIG, "break_minutes": 0},
        {**POMODORO_CONFIG, "blocks": 9},
        {**POMODORO_CONFIG, "long_break_minutes": 4},
    ],
)
def test_pomodoro_config_ranges(ada: TestClient, config: dict[str, Any]) -> None:
    r = ada.post("/api/sessions", json=make_session(mode="pomodoro", mode_config=config))
    assert r.status_code == 422


def test_unlimited_reminder_choices(ada: TestClient) -> None:
    for reminder in (None, 15, 120):
        cfg = {"mode": "unlimited", "reminder_minutes": reminder}
        assert (
            ada.post(
                "/api/sessions", json=make_session(mode="unlimited", mode_config=cfg)
            ).status_code
            == 201
        )
    bad = {"mode": "unlimited", "reminder_minutes": 20}
    assert (
        ada.post("/api/sessions", json=make_session(mode="unlimited", mode_config=bad)).status_code
        == 422
    )


def test_ac4_5_twelve_hours_of_focus_is_accepted(ada: TestClient) -> None:
    cfg = {"mode": "unlimited", "reminder_minutes": None}
    r = ada.post(
        "/api/sessions",
        json=make_session(
            mode="unlimited",
            mode_config=cfg,
            focus_seconds=43200,
            paused_seconds=600,
            ended_at="2026-10-23T21:10:00Z",
        ),
    )
    assert r.status_code == 201


def test_times_are_stored_in_utc(ada: TestClient, app_url: str) -> None:
    save(ada, started_at="2026-10-23T11:00:00+02:00", ended_at="2026-10-23T11:25:30+02:00")
    rows = run(_query(app_url, "SELECT started_at AT TIME ZONE 'UTC' FROM focus_sessions"))
    assert rows[0][0].hour == 9


def test_ac7_3_multiline_goal_is_saved_as_one_line(ada: TestClient) -> None:
    out = save(ada, goal="  first\r\nsecond\n\n\nthird\rfourth  ")
    assert out["goal"] == "first second third fourth"
    assert save(ada, goal="\n \n")["goal"] is None
    assert save(ada)["goal"] == "Write the report"


def test_ac13_5_length_is_checked_after_normalising(ada: TestClient) -> None:
    # 120 characters plus a trailing line break is fine; 121 is not.
    assert ada.post("/api/sessions", json=make_session(goal="x" * 120 + "\r\n")).status_code == 201
    assert ada.post("/api/sessions", json=make_session(goal="x" * 121)).status_code == 422


def test_ac13_5_logged_database_error_has_no_goal_text(app_url: str) -> None:
    goal = SessionIn.model_validate(make_session(goal="secret line one\nsecret line two")).goal
    assert goal == "secret line one secret line two"

    async def violate() -> str:
        engine = create_async_engine(app_url)
        try:
            async with engine.begin() as conn:
                await conn.execute(
                    FocusSession.__table__.insert().values(  # type: ignore[attr-defined]
                        id=uuid.uuid4(),
                        user_id=uuid.uuid4(),
                        mode="countdown",
                        tag="work",
                        goal=goal,
                        started_at="2026-10-23T09:00:00Z",
                        ended_at="2026-10-23T09:30:00Z",
                        focus_seconds=1800,
                        status="bogus",
                    )
                )
        except DBAPIError as exc:
            return str(exc)
        return ""

    message = run(violate())
    assert message  # a real database error was raised
    assert "secret" not in scrub(message)


def test_signed_out_requests_get_401(app_url: str) -> None:
    sid = uuid.uuid4()
    with TestClient(create_app(Settings(database_url=app_url, cookie_secure=False))) as c:
        calls = [
            c.post("/api/sessions", json=make_session()),
            c.post("/api/sessions/sync", json={"sessions": [make_session()]}),
            c.patch(f"/api/sessions/{sid}", json={"tag": "study"}),
            c.post(f"/api/sessions/{sid}/archive"),
            c.post(f"/api/sessions/{sid}/restore"),
            c.get("/api/sessions/archived"),
            c.delete("/api/sessions/archived"),
        ]
    assert [r.status_code for r in calls] == [401] * 7


# --- edit ----------------------------------------------------------------------------------


def test_ac11_1_edit_tag_and_goal(ada: TestClient) -> None:
    sid = save(ada)["id"]
    r = ada.patch(f"/api/sessions/{sid}", json={"tag": "study"})
    assert (r.json()["tag"], r.json()["goal"]) == ("study", "Write the report")
    r = ada.patch(f"/api/sessions/{sid}", json={"goal": "Chapter\n3"})
    assert (r.json()["tag"], r.json()["goal"]) == ("study", "Chapter 3")
    r = ada.patch(f"/api/sessions/{sid}", json={"goal": None})
    assert r.json()["goal"] is None
    r = ada.patch(f"/api/sessions/{sid}", json={"tag": "read", "goal": "Novel"})
    assert (r.json()["tag"], r.json()["goal"]) == ("read", "Novel")
    # times and durations are untouched
    assert r.json()["focus_seconds"] == 1500


@pytest.mark.parametrize(
    "body",
    [
        {},
        {"tag": None},
        {"tag": "gaming"},
        {"goal": "x" * 121},
        {"focus_seconds": 99},
        {"started_at": "2026-01-01T00:00:00Z"},
    ],
)
def test_ac11_1_invalid_edits_are_rejected(ada: TestClient, body: dict[str, Any]) -> None:
    sid = save(ada)["id"]
    assert ada.patch(f"/api/sessions/{sid}", json=body).status_code == 422


def test_ac11_4_archived_sessions_are_read_only(ada: TestClient) -> None:
    sid = save(ada)["id"]
    ada.post(f"/api/sessions/{sid}/archive")
    r = ada.patch(f"/api/sessions/{sid}", json={"tag": "study"})
    assert r.status_code == 409
    assert r.json()["error"]["code"] == "conflict"
    assert ada.get("/api/sessions/archived").json()["sessions"][0]["tag"] == "work"
    # a repeat save does not alter it either
    assert ada.post("/api/sessions", json=make_session(id=sid, tag="nap")).status_code == 200
    assert ada.get("/api/sessions/archived").json()["sessions"][0]["tag"] == "work"


def test_unknown_session_is_404(ada: TestClient) -> None:
    sid = uuid.uuid4()
    assert ada.patch(f"/api/sessions/{sid}", json={"tag": "study"}).status_code == 404
    assert ada.post(f"/api/sessions/{sid}/archive").status_code == 404
    assert ada.post(f"/api/sessions/{sid}/restore").status_code == 404
    assert ada.post("/api/sessions/nope/archive").status_code == 422


# --- archive, restore, delete ----------------------------------------------------------------


def test_ac11_2_to_5_archive_list_restore(ada: TestClient) -> None:
    first, second = save(ada), save(ada, tag="nap")
    assert ada.get("/api/sessions/archived").json() == {"sessions": []}

    a = ada.post(f"/api/sessions/{first['id']}/archive")
    assert a.status_code == 200 and a.json()["archived_at"] is not None
    stamp = a.json()["archived_at"]
    assert ada.post(f"/api/sessions/{first['id']}/archive").json()["archived_at"] == stamp
    ada.post(f"/api/sessions/{second['id']}/archive")
    listed = ada.get("/api/sessions/archived").json()["sessions"]
    assert [s["id"] for s in listed] == [second["id"], first["id"]]  # newest archived first

    r = ada.post(f"/api/sessions/{first['id']}/restore")
    assert r.json() == {**first, "archived_at": None}  # exactly as it was
    assert [s["id"] for s in ada.get("/api/sessions/archived").json()["sessions"]] == [second["id"]]
    assert ada.post(f"/api/sessions/{first['id']}/restore").status_code == 200  # idempotent
    assert ada.patch(f"/api/sessions/{first['id']}", json={"tag": "read"}).status_code == 200


def test_ac11_6_delete_all_archived_returns_count(ada: TestClient, app_url: str) -> None:
    assert ada.delete("/api/sessions/archived").json() == {"deleted": 0}
    keep = save(ada)
    gone = [save(ada) for _ in range(3)]
    for s in gone:
        ada.post(f"/api/sessions/{s['id']}/archive")
    assert ada.delete("/api/sessions/archived").json() == {"deleted": 3}
    assert ada.get("/api/sessions/archived").json() == {"sessions": []}
    assert count(app_url) == 1
    assert ada.patch(f"/api/sessions/{keep['id']}", json={"tag": "read"}).status_code == 200
    assert ada.delete("/api/sessions/archived").json() == {"deleted": 0}


def test_ac11_7_no_endpoint_deletes_a_non_archived_session(ada: TestClient, app_url: str) -> None:
    sid = save(ada)["id"]
    assert ada.delete(f"/api/sessions/{sid}").status_code == 405
    ada.delete("/api/sessions/archived")
    assert count(app_url) == 1


# --- user isolation (AC1.3) -------------------------------------------------------------------


def test_ac1_3_users_only_reach_their_own_sessions(
    ada: TestClient, bob: TestClient, app_url: str
) -> None:
    mine = save(ada)
    theirs = save(bob, tag="nap")
    bob.post(f"/api/sessions/{theirs['id']}/archive")

    # Ada cannot see, edit, archive, restore or delete Bob's session.
    assert ada.get("/api/sessions/archived").json() == {"sessions": []}
    assert ada.patch(f"/api/sessions/{theirs['id']}", json={"tag": "read"}).status_code == 404
    assert ada.post(f"/api/sessions/{theirs['id']}/restore").status_code == 404
    assert ada.post(f"/api/sessions/{theirs['id']}/archive").status_code == 404
    assert ada.delete("/api/sessions/archived").json() == {"deleted": 0}
    assert bob.get("/api/sessions/archived").json()["sessions"][0]["tag"] == "nap"
    assert count(app_url) == 2

    # Bob cannot touch Ada's either, nor delete it by deleting his archive.
    assert bob.post(f"/api/sessions/{mine['id']}/archive").status_code == 404
    assert bob.delete("/api/sessions/archived").json() == {"deleted": 1}
    assert ada.patch(f"/api/sessions/{mine['id']}", json={"tag": "study"}).status_code == 200


def test_ac1_3_a_session_id_owned_by_someone_else_is_a_conflict(
    ada: TestClient, bob: TestClient, app_url: str
) -> None:
    mine = save(ada)
    r = bob.post("/api/sessions", json=make_session(id=mine["id"], tag="nap"))
    assert r.status_code == 409
    assert "tag" not in r.text and "work" not in r.text  # nothing of Ada's leaks
    fresh = make_session()
    r = bob.post("/api/sessions/sync", json={"sessions": [fresh, make_session(id=mine["id"])]})
    assert r.status_code == 409
    assert count(app_url) == 1  # Bob's batch saved nothing
    assert ada.get("/api/sessions/archived").status_code == 200
