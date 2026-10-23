"""Accounts API (#8) against a real, migrated, throwaway Postgres."""

import logging
from collections.abc import Iterator
from concurrent.futures import ThreadPoolExecutor
from typing import Any

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncEngine, create_async_engine

from tests.integration.conftest import PASSWORD, MakeClient, run, signup

pytestmark = pytest.mark.integration


@pytest.fixture
def client(make_client: MakeClient) -> Iterator[TestClient]:
    with make_client() as c:
        yield c


async def _scalar(url: str, sql: str) -> list[Any]:
    engine: AsyncEngine = create_async_engine(url)
    try:
        async with engine.connect() as conn:
            return list((await conn.execute(text(sql))).all())
    finally:
        await engine.dispose()


async def _exec(url: str, sql: str) -> None:
    engine: AsyncEngine = create_async_engine(url)
    try:
        async with engine.begin() as conn:
            await conn.execute(text(sql))
    finally:
        await engine.dispose()


def test_ac1_1_signup_creates_account_and_signs_in(client: TestClient, test_db_url: str) -> None:
    r = signup(client)
    assert r.status_code == 201
    body = r.json()
    assert body["email"] == "ada@example.com"
    assert set(body) == {"id", "email", "created_at"}
    assert client.get("/api/auth/me").json()["email"] == "ada@example.com"
    rows = run(_scalar(test_db_url, "SELECT count(*) FROM user_settings"))
    assert rows == [(1,)]


def test_ac1_1_password_shorter_than_8_is_rejected(client: TestClient) -> None:
    r = signup(client, password="short77")
    assert r.status_code == 422
    detail = r.json()["error"]["details"][0]
    assert detail["field"] == "password"
    assert "short77" not in r.text
    assert signup(client, email="b@example.com", password="12345678").status_code == 201


@pytest.mark.parametrize("email", ["", "nope", "a@b", "a b@c.io", "@c.io"])
def test_ac1_1_invalid_email_is_rejected(client: TestClient, email: str) -> None:
    r = signup(client, email=email)
    assert r.status_code == 422
    assert r.json()["error"]["details"][0]["field"] == "email"


def test_ac1_1_duplicate_email_is_rejected_case_insensitively(client: TestClient) -> None:
    assert signup(client, "Ada@Example.com").status_code == 201
    r = signup(client, "ada@example.COM")
    assert r.status_code == 409
    err = r.json()["error"]
    assert err["code"] == "conflict"
    assert err["message"] == "An account with this email already exists"


def test_ac1_2_signin_signout_and_signed_out_requests_get_401(
    make_client: MakeClient,
) -> None:
    with make_client() as c:
        assert c.get("/api/_whoami").status_code == 401
        assert c.get("/api/auth/me").status_code == 401
        assert c.get("/api/auth/me").json()["error"]["code"] == "unauthorized"
        signup(c)
        assert c.post("/api/auth/signout").status_code == 204
        assert c.get("/api/_whoami").status_code == 401  # signed out

        bad = c.post("/api/auth/signin", json={"email": "ada@example.com", "password": "nope-nope"})
        assert bad.status_code == 401
        unknown = c.post(
            "/api/auth/signin", json={"email": "who@example.com", "password": PASSWORD}
        )
        assert unknown.status_code == 401
        assert bad.json() == unknown.json()  # does not reveal which emails exist

        ok = c.post("/api/auth/signin", json={"email": "ADA@example.com", "password": PASSWORD})
        assert ok.status_code == 200
        assert c.get("/api/_whoami").json() == {"email": "ada@example.com"}


def test_ac1_2_signout_invalidates_the_token_server_side(client: TestClient) -> None:
    signup(client)
    token = client.cookies["focus_session"]
    client.post("/api/auth/signout")
    client.cookies.set("focus_session", token)  # replay the old cookie
    assert client.get("/api/auth/me").status_code == 401


def test_ac1_2_signout_when_signed_out_is_ok(client: TestClient) -> None:
    assert client.post("/api/auth/signout").status_code == 204


def test_ac1_2_second_device_signs_in_independently(make_client: MakeClient) -> None:
    with make_client() as phone, make_client() as laptop:
        signup(phone)
        assert laptop.get("/api/auth/me").status_code == 401
        laptop.post("/api/auth/signin", json={"email": "ada@example.com", "password": PASSWORD})
        assert laptop.get("/api/auth/me").json()["email"] == "ada@example.com"
        laptop.post("/api/auth/signout")
        assert phone.get("/api/auth/me").status_code == 200  # other device stays signed in


def test_ac1_3_two_users_each_see_only_themselves(make_client: MakeClient) -> None:
    with make_client() as a, make_client() as b:
        signup(a, "a@example.com")
        signup(b, "b@example.com")
        assert a.get("/api/_whoami").json() == {"email": "a@example.com"}
        assert b.get("/api/_whoami").json() == {"email": "b@example.com"}
        assert a.get("/api/auth/me").json()["id"] != b.get("/api/auth/me").json()["id"]


def test_ac1_5_password_is_hashed_in_db_and_never_returned_or_logged(
    client: TestClient, test_db_url: str, caplog: pytest.LogCaptureFixture
) -> None:
    caplog.set_level(logging.DEBUG)
    r = signup(client)
    client.post("/api/auth/signin", json={"email": "ada@example.com", "password": "wrong-password"})
    assert PASSWORD not in r.text
    assert "password" not in r.text
    assert "hash" not in client.get("/api/auth/me").text
    (row,) = run(_scalar(test_db_url, "SELECT password_hash FROM users"))
    assert row[0].startswith("$argon2id$") and PASSWORD not in row[0]
    logged = "\n".join(rec.getMessage() for rec in caplog.records)
    assert PASSWORD not in logged and "wrong-password" not in logged


def test_session_token_is_stored_hashed(client: TestClient, test_db_url: str) -> None:
    signup(client)
    token = client.cookies["focus_session"]
    rows = run(_scalar(test_db_url, "SELECT token_hash FROM auth_sessions"))
    assert len(rows) == 1
    assert token not in rows[0][0]


def test_cookie_is_httponly_samesite_lax_and_secure_when_configured(
    make_client: MakeClient,
) -> None:
    with make_client(cookie_secure=True) as c:
        cookie = signup(c).headers["set-cookie"].lower()
        assert "httponly" in cookie and "samesite=lax" in cookie and "secure" in cookie
        assert "max-age=" in cookie and "path=/" in cookie
        out = c.post("/api/auth/signout").headers["set-cookie"].lower()
        assert "secure" in out and "httponly" in out
    with make_client(cookie_secure=False) as c:
        cookie = signup(c, "second@example.com").headers["set-cookie"].lower()
        assert "httponly" in cookie and "secure" not in cookie


def test_rate_limit_on_failed_signins(
    make_client: MakeClient,
) -> None:
    with make_client(signin_max_failures=3) as c:
        signup(c)
        c.post("/api/auth/signout")
        bad = {"email": "ada@example.com", "password": "wrong-password"}
        for _ in range(3):
            assert c.post("/api/auth/signin", json=bad).status_code == 401
        blocked = c.post("/api/auth/signin", json=bad)
        assert blocked.status_code == 429
        assert blocked.json()["error"]["code"] == "rate_limited"
        assert int(blocked.headers["retry-after"]) >= 1
        # Even the right password waits while blocked.
        good = {"email": "ada@example.com", "password": PASSWORD}
        assert c.post("/api/auth/signin", json=good).status_code == 429
        # Another account from the same client is not locked out by those failures.
        signup_other = signup(c, "other@example.com")  # sign-up is not limited
        assert signup_other.status_code == 201
        c.post("/api/auth/signout")
        other = {"email": "other@example.com", "password": PASSWORD}
        assert c.post("/api/auth/signin", json=other).status_code == 200


def test_successful_signin_resets_failure_count(
    make_client: MakeClient,
) -> None:
    with make_client(signin_max_failures=3) as c:
        signup(c)
        bad = {"email": "ada@example.com", "password": "wrong-password"}
        good = {"email": "ada@example.com", "password": PASSWORD}
        for _ in range(2):
            c.post("/api/auth/signin", json=bad)
        assert c.post("/api/auth/signin", json=good).status_code == 200
        for _ in range(2):
            assert c.post("/api/auth/signin", json=bad).status_code == 401


def test_expired_session_is_rejected(client: TestClient, test_db_url: str) -> None:
    signup(client)
    engine = create_async_engine(test_db_url)

    async def expire() -> None:
        async with engine.begin() as conn:
            await conn.execute(text("UPDATE auth_sessions SET expires_at = now() - interval '1 s'"))
        await engine.dispose()

    run(expire())
    assert client.get("/api/auth/me").status_code == 401


def test_deleting_a_user_removes_their_sign_ins(client: TestClient, test_db_url: str) -> None:
    signup(client)
    engine = create_async_engine(test_db_url)

    async def delete_user() -> None:
        async with engine.begin() as conn:
            await conn.execute(text("DELETE FROM users"))
        await engine.dispose()

    run(delete_user())
    assert run(_scalar(test_db_url, "SELECT count(*) FROM auth_sessions")) == [(0,)]


def test_burst_of_concurrent_signins_cannot_exceed_the_limit(make_client: MakeClient) -> None:
    limit = 5
    with make_client(signin_max_failures=limit) as c:
        signup(c)
        c.post("/api/auth/signout")
        bad = {"email": "ada@example.com", "password": "wrong-password"}
        with ThreadPoolExecutor(max_workers=20) as pool:
            codes = list(
                pool.map(lambda _: c.post("/api/auth/signin", json=bad).status_code, range(30))
            )
        assert codes.count(401) <= limit
        assert codes.count(401) + codes.count(429) == 30


def test_signup_is_rate_limited_per_client(make_client: MakeClient) -> None:
    with make_client(signup_max_per_client=2) as c:
        assert signup(c, "a@example.com").status_code == 201
        assert signup(c, "b@example.com").status_code == 201
        blocked = signup(c, "c@example.com")
        assert blocked.status_code == 429
        assert blocked.json()["error"]["code"] == "rate_limited"
        assert int(blocked.headers["retry-after"]) >= 1


def test_expired_sessions_are_deleted_on_sign_in(client: TestClient, test_db_url: str) -> None:
    signup(client)
    run(
        _exec(
            test_db_url,
            "INSERT INTO auth_sessions (token_hash, user_id, expires_at) "
            "SELECT 'old' || g, id, now() - interval '1 day' FROM users, generate_series(1, 3) g",
        )
    )
    assert len(run(_scalar(test_db_url, "SELECT 1 FROM auth_sessions"))) == 4
    client.post("/api/auth/signout")
    r = client.post("/api/auth/signin", json={"email": "ada@example.com", "password": PASSWORD})
    assert r.status_code == 200
    rows = run(_scalar(test_db_url, "SELECT token_hash FROM auth_sessions"))
    assert len(rows) == 1 and not rows[0][0].startswith("old")


def test_cookie_uses_host_prefix_when_secure(make_client: MakeClient) -> None:
    with make_client(cookie_secure=True) as c:
        cookie = signup(c).headers["set-cookie"]
        assert cookie.startswith("__Host-focus_session=")
        assert "path=/" in cookie.lower() and "domain" not in cookie.lower()
        token = c.cookies.get("__Host-focus_session")
        assert token
        c.cookies.clear()
        # Replayed over the test client's http: send the cookie by hand.
        ok = c.get("/api/auth/me", headers={"Cookie": f"__Host-focus_session={token}"})
        assert ok.status_code == 200
        old = c.get("/api/auth/me", headers={"Cookie": f"focus_session={token}"})
        assert old.status_code == 401
        out = c.post("/api/auth/signout").headers["set-cookie"]
        assert out.startswith("__Host-focus_session=")
    with make_client(cookie_secure=False) as c:
        assert signup(c, "second@example.com").headers["set-cookie"].startswith("focus_session=")
