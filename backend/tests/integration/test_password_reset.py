"""Password reset by email (F1, AC1.9, #350): request, link, confirm, rate limits, configuration.

The sender is a fake that records what it was asked to send, so the tests read the token the
way a user would (from the email) and need no mail server. Against a real Mailpit it is
exercised by the end-to-end journey.
"""

import asyncio
import hashlib
import logging
import re
import threading
import time
from collections.abc import Callable
from concurrent.futures import ThreadPoolExecutor
from typing import Any

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import text
from sqlalchemy.ext.asyncio import create_async_engine

from app.mailer import EmailConfig, EmailError, Message
from tests.integration.conftest import PASSWORD, MakeClient, run, signup

pytestmark = pytest.mark.integration

NEW_PASSWORD = "a brand new passphrase"
BASE = "https://ineedtofoc.us"
ADA = "ada@example.com"
TOKEN = re.compile(r"/reset-password#token=([^\s\"<]+)")


class FakeSender:
    """Records messages. `fail` is raised by `send`; `gate`, when set, holds `send` open."""

    def __init__(self) -> None:
        self.outbox: list[Message] = []
        self.fail: Exception | None = None
        self.gate: asyncio.Event | None = None
        self.started = 0

    async def send(self, message: Message) -> None:
        self.started += 1
        if self.gate is not None:
            await self.gate.wait()
        if self.fail is not None:
            raise self.fail
        self.outbox.append(message)


@pytest.fixture
def sender() -> FakeSender:
    return FakeSender()


@pytest.fixture
def client(make_client: MakeClient, sender: FakeSender) -> Any:
    with make_client(email=EmailConfig(sender, BASE, None)) as c:
        assert signup(c, ADA).status_code == 201
        c.post("/api/auth/signout")
        yield c


def wait_for(condition: Callable[[], bool], what: str = "the background work") -> None:
    deadline = time.monotonic() + 5
    while not condition():
        assert time.monotonic() < deadline, f"timed out waiting for {what}"
        time.sleep(0.01)


def settle(c: TestClient) -> None:
    """Wait until every reset task the app accepted has finished."""
    wait_for(lambda: not c.app.state.background_tasks, "reset tasks to finish")  # type: ignore[attr-defined]


def request(c: TestClient, email: str = ADA) -> Any:
    return c.post("/api/auth/password-reset", json={"email": email})


def token_of(message: Message) -> str:
    found = TOKEN.search(message.text)
    assert found, message.text
    return found[1]


def confirm(c: TestClient, token: str, password: str = NEW_PASSWORD) -> Any:
    return c.post("/api/auth/password-reset/confirm", json={"token": token, "password": password})


def signin(c: TestClient, password: str, email: str = ADA) -> Any:
    return c.post("/api/auth/signin", json={"email": email, "password": password})


async def _rows(url: str, sql: str) -> list[tuple[Any, ...]]:
    engine = create_async_engine(url)
    try:
        async with engine.begin() as conn:
            result = await conn.execute(text(sql))
            return [tuple(r) for r in result.fetchall()] if result.returns_rows else []
    finally:
        await engine.dispose()


def sql(url: str, statement: str) -> list[tuple[Any, ...]]:
    return run(_rows(url, statement))


def reset_email(c: TestClient, sender: FakeSender) -> str:
    """Request a reset for Ada and return the token from the email."""
    before = len(sender.outbox)
    assert request(c).status_code == 202
    wait_for(lambda: len(sender.outbox) > before, "the email")
    return token_of(sender.outbox[-1])


# --- AC 2: request ----------------------------------------------------------------------


def test_ac2_the_response_is_the_same_for_an_existing_and_an_unknown_email(
    client: TestClient, sender: FakeSender
) -> None:
    known = request(client, ADA)
    unknown = request(client, "nobody@example.com")
    assert known.status_code == unknown.status_code == 202
    assert known.json() == unknown.json() == {"status": "accepted"}
    assert dict(known.headers) == dict(unknown.headers)
    settle(client)
    assert [m.to for m in sender.outbox] == [ADA]  # only the existing account gets mail


def test_ac2_the_email_is_matched_case_insensitively(
    client: TestClient, sender: FakeSender
) -> None:
    assert request(client, "  ADA@Example.COM ").status_code == 202
    settle(client)
    assert [m.to for m in sender.outbox] == [ADA]


def test_ac2_an_invalid_email_is_a_422(client: TestClient) -> None:
    r = client.post("/api/auth/password-reset", json={"email": "not an email"})
    assert r.status_code == 422
    assert r.json()["error"]["code"] == "validation_error"
    assert client.post("/api/auth/password-reset", json={}).status_code == 422


def test_ac2_the_response_does_not_wait_for_the_sender(
    make_client: MakeClient, sender: FakeSender
) -> None:
    """Lookup, token write and send all happen after the 202 (AC 6), so a slow or stuck
    provider can't be told apart by response time, and an unknown email costs the same."""
    with make_client(email=EmailConfig(sender, BASE, None)) as c:
        signup(c, ADA)
        c.post("/api/auth/signout")
        sender.gate = asyncio.Event()  # `send` now blocks until released
        started = time.monotonic()
        r = request(c)
        elapsed = time.monotonic() - started
        assert r.status_code == 202
        assert elapsed < 2, "the response waited for the sender"
        wait_for(lambda: sender.started == 1, "the send to start")
        assert sender.outbox == []  # still stuck inside `send`
        loop_gate = sender.gate
        assert c.portal is not None
        c.portal.call(loop_gate.set)  # set on the app's own event loop
        wait_for(lambda: len(sender.outbox) == 1, "the email")


def test_ac2_the_rate_limit_is_3_per_email_per_hour(client: TestClient, sender: FakeSender) -> None:
    for _ in range(3):
        assert request(client).status_code == 202
    limited = request(client)
    assert limited.status_code == 429
    assert limited.json()["error"]["code"] == "rate_limited"
    assert 3590 <= int(limited.headers["Retry-After"]) <= 3601  # the hour's window
    settle(client)
    assert len(sender.outbox) == 3  # a limited request sends nothing
    # Other emails are unaffected, and an unknown email is limited just the same.
    assert request(client, "other@example.com").status_code == 202
    for _ in range(3):
        assert request(client, "nobody@example.com").status_code == 202
    assert request(client, "nobody@example.com").status_code == 429


def test_ac2_the_rate_limit_is_10_per_client_per_hour(
    client: TestClient, sender: FakeSender
) -> None:
    for n in range(10):
        assert request(client, f"user{n}@example.com").status_code == 202
    limited = request(client, ADA)
    assert limited.status_code == 429
    assert "Retry-After" in limited.headers
    settle(client)
    assert sender.outbox == []  # none of those accounts exist, and Ada's request sent nothing


def test_ac2_a_limited_request_does_not_use_up_the_other_quota(
    client: TestClient, sender: FakeSender
) -> None:
    for _ in range(3):
        request(client)
    for _ in range(5):
        assert request(client).status_code == 429  # refused by the email quota, uncounted
    for n in range(7):  # 3 used so far, so 7 more fit in the client's 10
        assert request(client, f"user{n}@example.com").status_code == 202


def test_ac2_a_newer_link_invalidates_the_earlier_one(
    client: TestClient, sender: FakeSender
) -> None:
    first = reset_email(client, sender)
    second = reset_email(client, sender)
    assert first != second
    assert confirm(client, first).status_code == 400
    assert confirm(client, second).status_code == 204


# --- AC 3: the link and the stored token ------------------------------------------------


def test_ac3_the_link_keeps_the_token_in_the_fragment(
    client: TestClient, sender: FakeSender
) -> None:
    token = reset_email(client, sender)
    assert f"{BASE}/reset-password#token={token}" in sender.outbox[0].text
    assert len(token) >= 43  # 32 random bytes, URL-safe base64
    assert "?" not in sender.outbox[0].text.split("#token=")[0].splitlines()[-1]


def test_ac3_only_the_hash_is_stored_and_the_link_lasts_60_minutes(
    client: TestClient, sender: FakeSender, test_db_url: str
) -> None:
    token = reset_email(client, sender)
    ((stored, minutes, used),) = sql(
        test_db_url,
        "SELECT token_hash, extract(epoch FROM expires_at - created_at) / 60, used_at "
        "FROM password_reset_tokens",
    )
    assert stored == hashlib.sha256(token.encode()).hexdigest()
    assert len(stored) == 64
    assert 59.9 < float(minutes) < 60.1
    assert used is None
    dump = repr(sql(test_db_url, "SELECT * FROM password_reset_tokens"))
    assert token not in dump


def test_ac3_a_link_expires_after_60_minutes(
    client: TestClient, sender: FakeSender, test_db_url: str
) -> None:
    token = reset_email(client, sender)
    sql(test_db_url, "UPDATE password_reset_tokens SET expires_at = now() - interval '1 second'")
    expired = confirm(client, token)
    assert expired.status_code == 400
    assert expired.json()["error"]["code"] == "invalid_token"
    assert expired.json()["error"]["message"] == (
        "This link has expired or was already used. Ask for a new one."
    )
    assert signin(client, PASSWORD).status_code == 200  # nothing changed


def test_ac3_a_link_a_minute_before_expiry_still_works(
    client: TestClient, sender: FakeSender, test_db_url: str
) -> None:
    token = reset_email(client, sender)
    sql(test_db_url, "UPDATE password_reset_tokens SET expires_at = now() + interval '1 minute'")
    assert confirm(client, token).status_code == 204


# --- AC 4: the email --------------------------------------------------------------------


def test_ac4_the_email_text(client: TestClient, sender: FakeSender) -> None:
    reset_email(client, sender)
    (message,) = sender.outbox
    assert message.subject == "Reset your I Need To Focus password"
    assert message.to == ADA
    for body in (message.text, message.html):
        assert "This link expires in 60 minutes" in body
        assert (
            "If you didn't ask for this, ignore this email; your password hasn't changed." in body
        )
    assert "<img" not in message.html


# --- AC 5: confirm ----------------------------------------------------------------------


def test_ac5_a_valid_token_sets_the_password_and_signs_nobody_in(
    client: TestClient, sender: FakeSender, test_db_url: str
) -> None:
    token = reset_email(client, sender)
    done = confirm(client, token)
    assert done.status_code == 204
    assert "set-cookie" not in done.headers  # no automatic sign-in
    assert client.get("/api/auth/me").status_code == 401
    assert signin(client, PASSWORD).status_code == 401
    assert signin(client, NEW_PASSWORD).status_code == 200
    ((hash_,),) = sql(test_db_url, "SELECT password_hash FROM users")
    assert hash_.startswith("$argon2id$")
    assert NEW_PASSWORD not in hash_
    ((used,),) = sql(test_db_url, "SELECT used_at FROM password_reset_tokens")
    assert used is not None


def test_ac5_a_token_works_once(client: TestClient, sender: FakeSender) -> None:
    token = reset_email(client, sender)
    assert confirm(client, token).status_code == 204
    again = confirm(client, token, "yet another passphrase")
    assert again.status_code == 400
    assert again.json()["error"]["code"] == "invalid_token"
    assert signin(client, NEW_PASSWORD).status_code == 200  # the second attempt changed nothing


def test_ac5_two_simultaneous_requests_with_one_token_cannot_both_succeed(
    client: TestClient, sender: FakeSender, make_client: MakeClient
) -> None:
    token = reset_email(client, sender)
    with make_client(email=EmailConfig(sender, BASE, None)) as other, ThreadPoolExecutor(2) as pool:
        both = [
            pool.submit(confirm, client, token, "first passphrase!"),
            pool.submit(confirm, other, token, "second passphrase!"),
        ]
        results = sorted(f.result().status_code for f in both)
    assert results == [204, 400]


def test_ac5_an_unknown_token_is_the_same_400(client: TestClient) -> None:
    r = confirm(client, "no-such-token")
    assert r.status_code == 400
    assert r.json() == {
        "error": {
            "code": "invalid_token",
            "message": "This link has expired or was already used. Ask for a new one.",
        }
    }


@pytest.mark.parametrize("password", ["short", "x" * 7, "p" * 129])
def test_ac5_the_password_is_8_to_128_characters(
    client: TestClient, sender: FakeSender, password: str
) -> None:
    token = reset_email(client, sender)
    r = confirm(client, token, password)
    assert r.status_code == 422
    assert r.json()["error"]["code"] == "validation_error"
    assert r.json()["error"]["details"][0]["field"] == "password"
    assert confirm(client, token).status_code == 204  # a refused password doesn't burn the link
    assert confirm(client, token, "p" * 128).status_code == 400


def test_ac5_a_128_character_password_is_accepted(client: TestClient, sender: FakeSender) -> None:
    token = reset_email(client, sender)
    assert confirm(client, token, "p" * 128).status_code == 204
    assert signin(client, "p" * 128).status_code == 200


def test_ac5_every_sign_in_of_the_account_on_every_device_ends(
    make_client: MakeClient, sender: FakeSender
) -> None:
    with (
        make_client(email=EmailConfig(sender, BASE, None)) as laptop,
        make_client(email=EmailConfig(sender, BASE, None)) as phone,
        make_client(email=EmailConfig(sender, BASE, None)) as bob,
    ):
        assert signup(laptop, ADA).status_code == 201
        assert signin(phone, PASSWORD).status_code == 200
        assert signup(bob, "bob@example.com").status_code == 201
        token = reset_email(laptop, sender)
        assert laptop.get("/api/auth/me").status_code == 200  # signed in until the reset
        assert confirm(phone, token).status_code == 204
        assert laptop.get("/api/auth/me").status_code == 401
        assert phone.get("/api/auth/me").status_code == 401
        # Another account is untouched: its sign-in and its password.
        assert bob.get("/api/auth/me").status_code == 200
        bob.post("/api/auth/signout")
        assert signin(bob, PASSWORD, "bob@example.com").status_code == 200


def test_ac5_the_reset_clears_the_sign_in_lockout_for_that_email(
    client: TestClient, sender: FakeSender
) -> None:
    for _ in range(5):
        assert signin(client, "wrong password").status_code == 401
    assert signin(client, NEW_PASSWORD).status_code == 429  # locked out, 5 per client+email
    token = reset_email(client, sender)
    assert confirm(client, token).status_code == 204
    assert signin(client, NEW_PASSWORD).status_code == 200


# --- AC 6: configuration ----------------------------------------------------------------


def test_ac6_options_report_whether_reset_is_available(
    make_client: MakeClient, sender: FakeSender
) -> None:
    with make_client() as unconfigured:  # no EMAIL_* settings
        assert unconfigured.get("/api/auth/options").json() == {"password_reset": False}
    with make_client(email=EmailConfig(sender, BASE, None)) as configured:
        r = configured.get("/api/auth/options")  # unauthenticated
        assert r.status_code == 200
        assert r.json() == {"password_reset": True}


def test_ac6_unconfigured_the_request_is_a_503_and_nothing_is_counted_or_sent(
    make_client: MakeClient,
) -> None:
    with make_client() as c:
        signup(c, ADA)
        for _ in range(5):  # never rate limited: it fails before the limiter
            r = request(c)
            assert r.status_code == 503
            assert r.json()["error"]["code"] == "unavailable"


def test_ac6_the_settings_make_a_working_app(make_client: MakeClient) -> None:
    """From environment-style settings, not an injected sender (SMTP to a closed port)."""
    with make_client(
        email_provider="smtp",
        email_smtp_host="127.0.0.1",
        email_smtp_port="1",
        email_from="I Need To Focus <no-reply@ineedtofoc.us>",
        app_base_url="http://localhost:8000",
    ) as c:
        assert c.get("/api/auth/options").json() == {"password_reset": True}
        assert request(c).status_code == 202


def test_ac6_a_missing_variable_logs_one_startup_warning_naming_it(
    make_client: MakeClient, capsys: pytest.CaptureFixture[str]
) -> None:
    # The app's own JSON log handler replaces pytest's, so read what it printed.
    with make_client(
        email_provider="ses", email_api_key="AKIDONLY", email_aws_region="us-east-1"
    ) as c:
        assert c.get("/api/auth/options").json() == {"password_reset": False}
    out = capsys.readouterr().out
    warnings = [line for line in out.splitlines() if "password reset by email is off" in line]
    assert len(warnings) == 1
    assert "APP_BASE_URL" in warnings[0]  # the first variable found missing, by name
    assert "AKIDONLY" not in out


# --- Failures after the 202 (AC 6, AC 7) ------------------------------------------------


def test_a_send_failure_is_a_202_and_logs_only_the_error_code(
    client: TestClient, sender: FakeSender, caplog: pytest.LogCaptureFixture
) -> None:
    caplog.set_level(logging.ERROR)
    sender.fail = EmailError("MessageRejected")
    assert request(client).status_code == 202
    settle(client)
    (record,) = [r for r in caplog.records if r.name == "app.password_reset"]
    assert record.error_type == "EmailError"  # type: ignore[attr-defined]
    assert record.error_code == "MessageRejected"  # type: ignore[attr-defined]
    assert ADA not in caplog.text


def test_a_failure_with_the_address_in_its_text_never_reaches_the_log(
    client: TestClient, sender: FakeSender, caplog: pytest.LogCaptureFixture
) -> None:
    caplog.set_level(logging.DEBUG)
    sender.fail = RuntimeError(f"cannot deliver to {ADA}")
    assert request(client).status_code == 202
    settle(client)
    assert ADA not in caplog.text and "cannot deliver" not in caplog.text
    (record,) = [r for r in caplog.records if r.name == "app.password_reset"]
    assert record.error_type == "RuntimeError"  # type: ignore[attr-defined]
    assert record.exc_info is None


def test_a_slow_send_is_cut_off_after_the_timeout(
    client: TestClient, sender: FakeSender, monkeypatch: pytest.MonkeyPatch
) -> None:
    import app.password_reset as module

    monkeypatch.setattr(module, "SEND_TIMEOUT_SECONDS", 0.2)
    sender.gate = asyncio.Event()  # never set: `send` would wait forever
    assert request(client).status_code == 202
    settle(client)  # finishes by timing out, not by the gate opening
    assert sender.outbox == []


def test_a_failure_in_the_lookup_after_the_202_is_still_a_202(
    client: TestClient,
    sender: FakeSender,
    monkeypatch: pytest.MonkeyPatch,
    caplog: pytest.LogCaptureFixture,
) -> None:
    import app.password_reset as module

    async def broken(app: Any, email: str) -> str | None:
        raise ConnectionError(f"database said no about {email}")

    monkeypatch.setattr(module, "_issue_token", broken)
    caplog.set_level(logging.ERROR)
    assert request(client).status_code == 202
    settle(client)
    assert sender.outbox == []
    assert ADA not in caplog.text and "database said no" not in caplog.text
    (record,) = [r for r in caplog.records if r.name == "app.password_reset"]
    assert record.error_type == "ConnectionError"  # type: ignore[attr-defined]


def test_the_account_still_signs_in_with_the_old_password_until_a_reset_completes(
    client: TestClient, sender: FakeSender
) -> None:
    reset_email(client, sender)
    assert signin(client, PASSWORD).status_code == 200


def test_deleting_the_user_removes_their_reset_links(
    client: TestClient, sender: FakeSender, test_db_url: str
) -> None:
    reset_email(client, sender)
    assert sql(test_db_url, "SELECT count(*) FROM password_reset_tokens") == [(1,)]
    sql(test_db_url, "DELETE FROM users")
    assert sql(test_db_url, "SELECT count(*) FROM password_reset_tokens") == [(0,)]


def test_old_links_are_cleaned_up_on_the_next_request(
    client: TestClient, sender: FakeSender, test_db_url: str
) -> None:
    reset_email(client, sender)
    sql(test_db_url, "UPDATE password_reset_tokens SET expires_at = now() - interval '2 days'")
    reset_email(client, sender)
    assert sql(test_db_url, "SELECT count(*) FROM password_reset_tokens") == [(1,)]


def test_ac5_a_sign_in_that_checked_the_old_password_before_the_reset_gets_no_session(
    client: TestClient,
    sender: FakeSender,
    make_client: MakeClient,
    monkeypatch: pytest.MonkeyPatch,
    test_db_url: str,
) -> None:
    """The password was verified, then the reset committed, then the session would be inserted:
    the sign-in must fail, or the reset's sweep of sign-ins would have missed it."""
    import app.auth as auth
    from app import security

    real = security.verify_password
    checked, go = threading.Event(), threading.Event()

    async def held(password: str, password_hash: str | None) -> bool:
        ok = await real(password, password_hash)
        checked.set()
        await asyncio.to_thread(go.wait, 10)
        return ok

    token = reset_email(client, sender)
    monkeypatch.setattr(auth, "verify_password", held)
    with make_client(email=EmailConfig(sender, BASE, None)) as other, ThreadPoolExecutor(1) as pool:
        late = pool.submit(signin, other, PASSWORD)
        assert checked.wait(10)
        assert confirm(client, token).status_code == 204
        go.set()
        result = late.result(timeout=10)
        assert result.status_code == 401
        assert other.get("/api/auth/me").status_code == 401
    assert sql(test_db_url, "SELECT count(*) FROM auth_sessions") == [(0,)]


def test_a_confirm_takes_the_account_lock_before_the_token_lock(
    client: TestClient, sender: FakeSender, test_db_url: str
) -> None:
    """A new request locks the account, then its tokens; confirm must take them in the same
    order or the two can deadlock. With the account locked elsewhere, a confirm must be waiting
    on it while holding no lock on the token row."""
    token = reset_email(client, sender)

    async def scenario() -> int:
        engine = create_async_engine(test_db_url)
        try:
            async with engine.connect() as holder:
                await holder.execute(text("SELECT id FROM users FOR UPDATE"))
                with ThreadPoolExecutor(1) as pool:
                    pending = pool.submit(confirm, client, token)
                    try:
                        await asyncio.sleep(1)  # the confirm is now waiting for the account
                        assert not pending.done()
                        async with engine.connect() as probe:
                            await probe.execute(
                                text("SELECT 1 FROM password_reset_tokens FOR UPDATE NOWAIT")
                            )
                            await probe.rollback()
                    finally:
                        await holder.rollback()  # always let the confirm go on
                    return int((await asyncio.to_thread(pending.result)).status_code)
        finally:
            await engine.dispose()

    assert run(scenario()) == 204
