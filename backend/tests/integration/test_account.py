"""Account export and deletion (#349, AC1.6, AC1.7) against a real throwaway Postgres."""

import json
import logging
import re
from datetime import UTC, datetime

import pytest
from fastapi.testclient import TestClient
from opentelemetry.sdk.trace import TracerProvider
from opentelemetry.sdk.trace.export import SimpleSpanProcessor
from opentelemetry.sdk.trace.export.in_memory_span_exporter import InMemorySpanExporter

from app.config import Settings
from app.main import create_app
from app.telemetry import install_privacy_filters
from tests.integration.conftest import PASSWORD, MakeClient, run, signup
from tests.integration.test_auth import _scalar
from tests.integration.test_sessions import make_session

pytestmark = pytest.mark.integration

GOAL = "Secret goal about the merger"
LINK = "https://www.youtube.com/watch?v=dQw4w9WgXcQ"
COOKIE = "focus_session"


def _populate(c: TestClient, goal: str, link: str, started: str) -> str:
    s = make_session(goal=goal, started_at=started, ended_at=started[:14] + "25:30Z")
    assert c.post("/api/sessions", json=s).status_code == 201
    assert c.post("/api/youtube-links", json={"url": link, "title": "A title"}).status_code == 200
    return str(s["id"])


def _delete(c: TestClient, password: str | None = PASSWORD):  # type: ignore[no-untyped-def]
    return c.post("/api/account/delete", json={} if password is None else {"password": password})


def test_ac2_export_requires_sign_in(make_client: MakeClient) -> None:
    with make_client() as c:
        r = c.get("/api/account/export")
        assert r.status_code == 401
        assert c.post("/api/account/delete", json={"password": PASSWORD}).status_code == 401


def test_ac2_export_is_complete_and_scoped(ada: TestClient, bob: TestClient) -> None:
    first = _populate(ada, GOAL, LINK, "2026-10-23T09:00:00Z")
    old = make_session(started_at="2026-10-20T09:00:00Z", ended_at="2026-10-20T09:25:30Z")
    assert ada.post("/api/sessions", json=old).status_code == 201
    assert ada.post(f"/api/sessions/{old['id']}/archive").status_code == 200
    bob_id = _populate(bob, "Bob goal", "https://youtu.be/BOBBOBBOB11", "2026-10-22T09:00:00Z")
    assert bob.patch("/api/settings", json={"alert_volume": 11}).status_code == 200

    r = ada.get("/api/account/export")
    assert r.status_code == 200
    assert r.headers["content-type"].startswith("application/json")
    today = datetime.now(UTC).strftime("%Y-%m-%d")
    assert r.headers["content-disposition"] == (
        f'attachment; filename="ineedtofocus-export-{today}.json"'
    )
    body = r.json()
    assert list(body) == [
        "format_version",
        "exported_at",
        "account",
        "settings",
        "sessions",
        "youtube_links",
    ]
    assert body["format_version"] == 1
    assert body["exported_at"].endswith("Z")
    assert body["account"]["email"] == "ada@example.com"
    assert set(body["account"]) == {"email", "created_at"}
    assert body["settings"] == ada.get("/api/settings").json()
    # Oldest first, archived included, every stored field, UTC timestamps.
    assert [s["id"] for s in body["sessions"]] == [old["id"], first]
    assert body["sessions"][0]["archived_at"] is not None
    assert set(body["sessions"][0]) == {
        "id",
        "mode",
        "tag",
        "goal",
        "started_at",
        "ended_at",
        "focus_seconds",
        "paused_seconds",
        "status",
        "mode_config",
        "blocks_completed",
        "archived_at",
        "created_at",
    }
    assert body["sessions"][1]["started_at"] == "2026-10-23T09:00:00Z"
    assert body["sessions"][1]["goal"] == GOAL
    assert [link["url"] for link in body["youtube_links"]] == [LINK]
    assert set(body["youtube_links"][0]) == {"url", "title", "last_used_at"}
    # Nothing of the other account, no hash, no sign-in records.
    text = r.text
    for secret in ("bob", "Bob goal", "BOBBOBBOB11", bob_id, "argon2", "password", "token"):
        assert secret not in text
    assert body["settings"]["alert_volume"] != 11


def test_ac2_export_of_a_new_account_is_empty(ada: TestClient) -> None:
    body = ada.get("/api/account/export").json()
    assert body["sessions"] == [] and body["youtube_links"] == []
    assert body["settings"]["alert_volume"] == 80


def test_ac3_delete_cascades_clears_cookie_and_allows_signup(
    make_client: MakeClient, test_db_url: str
) -> None:
    with make_client() as c, make_client() as other_device, make_client() as bob:
        signup(c)
        signup(bob, "bob@example.com")
        assert (
            other_device.post(
                "/api/auth/signin", json={"email": "ada@example.com", "password": PASSWORD}
            ).status_code
            == 200
        )
        _populate(c, GOAL, LINK, "2026-10-23T09:00:00Z")
        archived = make_session(started_at="2026-10-20T09:00:00Z", ended_at="2026-10-20T09:25:30Z")
        c.post("/api/sessions", json=archived)
        c.post(f"/api/sessions/{archived['id']}/archive")
        _populate(bob, "Bob goal", "https://youtu.be/BOBBOBBOB11", "2026-10-22T09:00:00Z")
        old_token = c.cookies[COOKIE]

        r = _delete(c)
        assert r.status_code == 204 and r.content == b""
        set_cookie = r.headers["set-cookie"].lower()
        assert set_cookie.startswith(f"{COOKIE}=") and "max-age=0" in set_cookie
        assert "httponly" in set_cookie and "samesite=lax" in set_cookie and "path=/" in set_cookie

        for table in ("users", "user_settings", "auth_sessions", "focus_sessions"):
            (row,) = run(_scalar(test_db_url, f"SELECT count(*) FROM {table}"))
            assert row[0] > 0  # Bob's rows remain
        for table, col in (
            ("user_settings", "user_id"),
            ("auth_sessions", "user_id"),
            ("focus_sessions", "user_id"),
            ("youtube_recent_links", "user_id"),
        ):
            (row,) = run(
                _scalar(
                    test_db_url,
                    f"SELECT count(*) FROM {table} WHERE {col} IN "
                    "(SELECT id FROM users WHERE email = 'ada@example.com')",
                )
            )
            assert row[0] == 0
        ada_rows = _scalar(test_db_url, "SELECT count(*) FROM users WHERE email LIKE 'ada@%'")
        assert run(ada_rows) == [(0,)]
        assert run(_scalar(test_db_url, "SELECT count(*) FROM focus_sessions")) == [(1,)]
        assert run(_scalar(test_db_url, "SELECT count(*) FROM youtube_recent_links")) == [(1,)]

        # The old cookie, here and on the other device, is 401 everywhere.
        c.cookies.set(COOKIE, old_token)
        assert c.get("/api/auth/me").status_code == 401
        assert c.get("/api/account/export").status_code == 401
        assert other_device.get("/api/sessions/archived").status_code == 401
        assert bob.get("/api/auth/me").status_code == 200

        # The same email signs up again as a new, empty account.
        c.cookies.clear()
        assert signup(c).status_code == 201
        assert c.get("/api/account/export").json()["sessions"] == []
        assert c.get("/api/youtube-links").json() == {"links": []}


@pytest.mark.parametrize("password", ["wrong-password", "", None])
def test_ac3_wrong_or_missing_password_is_403_and_deletes_nothing(
    ada: TestClient, password: str | None
) -> None:
    _populate(ada, GOAL, LINK, "2026-10-23T09:00:00Z")
    r = _delete(ada, password)
    assert r.status_code == 403
    assert r.json()["error"] == {"code": "forbidden", "message": "Incorrect password"}
    assert "set-cookie" not in r.headers
    assert ada.get("/api/auth/me").status_code == 200
    assert len(ada.get("/api/account/export").json()["sessions"]) == 1


def test_ac3_failed_attempts_hit_the_signin_limiter(make_client: MakeClient) -> None:
    with make_client(signin_max_failures=3) as c:
        signup(c)
        for _ in range(3):
            assert _delete(c, "wrong-password").status_code == 403
        blocked = _delete(c, "wrong-password")
        assert blocked.status_code == 429
        assert blocked.json()["error"]["code"] == "rate_limited"
        assert int(blocked.headers["retry-after"]) >= 1
        # Even the right password waits while blocked; nothing was deleted.
        assert _delete(c).status_code == 429
        assert c.get("/api/auth/me").status_code == 200


def test_ac3_per_client_limit_counts_across_emails(make_client: MakeClient) -> None:
    with make_client(signin_max_failures_per_client=2) as c:
        signup(c)
        assert _delete(c, "wrong-password").status_code == 403
        assert _delete(c, "wrong-password").status_code == 403
        assert _delete(c, "wrong-password").status_code == 429


def test_ac3_failed_signins_count_toward_delete(make_client: MakeClient) -> None:
    with make_client(signin_max_failures=2) as c:
        signup(c)
        bad = {"email": "ada@example.com", "password": "wrong-password"}
        assert c.post("/api/auth/signin", json=bad).status_code == 401
        assert c.post("/api/auth/signin", json=bad).status_code == 401
        assert _delete(c).status_code == 429


def test_ac3_a_successful_delete_does_not_use_up_the_limit(make_client: MakeClient) -> None:
    with make_client(signin_max_failures=2) as c:
        signup(c)
        assert _delete(c, "wrong-password").status_code == 403
        assert _delete(c).status_code == 204
        signup(c)
        assert _delete(c, "wrong-password").status_code == 403


def test_ac3_overlong_password_is_422(ada: TestClient) -> None:
    assert _delete(ada, "x" * 129).status_code == 422
    assert ada.post("/api/account/delete", json={"password": PASSWORD, "x": 1}).status_code == 422


def test_ac4_nothing_personal_in_logs(ada: TestClient, caplog: pytest.LogCaptureFixture) -> None:
    caplog.set_level(logging.DEBUG)
    user_id = ada.get("/api/auth/me").json()["id"]
    _populate(ada, GOAL, LINK, "2026-10-23T09:00:00Z")
    ada.get("/api/account/export")
    _delete(ada, "wrong-password-xyz")
    assert _delete(ada).status_code == 204
    logged = "\n".join(rec.getMessage() for rec in caplog.records)
    for secret in ("ada@example.com", "ada", PASSWORD, "wrong-password-xyz", GOAL, "dQw4w9WgXcQ"):
        assert secret not in logged
    deleted = [r for r in caplog.records if r.getMessage() == "account deleted"]
    assert len(deleted) == 1
    assert deleted[0].user_id == user_id  # type: ignore[attr-defined]


def test_ac4_spans_carry_no_personal_data_or_ids_in_routes(app_url: str) -> None:
    exporter = InMemorySpanExporter()
    provider = TracerProvider()
    assert install_privacy_filters(provider) is True
    provider.add_span_processor(SimpleSpanProcessor(exporter))
    app = create_app(Settings(database_url=app_url, cookie_secure=False), tracer_provider=provider)
    with TestClient(app) as c:
        signup(c)
        _populate(c, GOAL, LINK, "2026-10-23T09:00:00Z")
        c.get("/api/account/export")
        _delete(c, "wrong-password-xyz")
        assert _delete(c).status_code == 204
    spans = exporter.get_finished_spans()
    dumped = json.dumps(
        [
            {"name": s.name, "attrs": {k: str(v) for k, v in (s.attributes or {}).items()}}
            for s in spans
        ]
    )
    for secret in ("ada@example.com", PASSWORD, "wrong-password-xyz", GOAL, "dQw4w9WgXcQ"):
        assert secret not in dumped
    routes = {
        (s.attributes or {}).get("http.route")
        for s in spans
        if (s.attributes or {}).get("http.route", "").startswith("/api/account")  # type: ignore[union-attr]
    }
    assert routes == {"/api/account/export", "/api/account/delete"}
    assert not re.search(r"@|%40", " ".join(str(r) for r in routes))
