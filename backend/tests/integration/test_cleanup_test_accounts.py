"""The dev clean-up command (#423) against a real, migrated, throwaway Postgres."""

import io
import logging
import os
import subprocess
import sys
from datetime import timedelta
from typing import Any

import pytest

from app import cleanup_test_accounts as cta
from app.models import Base
from tests.integration.conftest import BACKEND, MakeClient, run, signup
from tests.integration.test_sessions import _query, make_session

pytestmark = pytest.mark.integration

REAL = [
    "user@example.com.evil.test",
    "user@notexample.com",
    "real@gmail.com",
    "x@sub.example.com",
    "u@ex\u0430mple.com",
]  # Cyrillic a


def seed(make_client: MakeClient, email: str, age: str = "3 hours") -> None:
    """Sign up and give the account a row in every child table, then age it."""
    with make_client() as c:
        assert signup(c, email).status_code == 201
        assert c.post("/api/sessions", json=make_session()).status_code in (200, 201)
        assert c.post("/api/tags", json={"name": "deep", "color": "red"}).status_code == 201
        assert c.post("/api/youtube-links", json={"url": "https://youtu.be/abc"}).status_code == 200
        assert c.patch("/api/settings", json={"week_start_day": 1}).status_code == 200
        assert c.post("/api/calendar/feed").status_code in (200, 201)


def age_all(url: str, interval: str = "3 hours") -> None:
    run(_query(url, "SELECT 1"))  # fail early if the database is unreachable
    run(_exec(url, f"UPDATE users SET created_at = now() - interval '{interval}'"))


async def _exec(url: str, sql: str) -> None:
    from sqlalchemy import text
    from sqlalchemy.ext.asyncio import create_async_engine

    engine = create_async_engine(url)
    try:
        async with engine.begin() as conn:
            await conn.execute(text(sql))
    finally:
        await engine.dispose()


def emails(url: str) -> list[str]:
    return sorted(r[0] for r in run(_query(url, "SELECT email FROM users")))


def total_children(url: str) -> dict[str, int]:
    return {t: int(run(_query(url, f"SELECT count(*) FROM {t}"))[0][0]) for t in cta_tables()}


def cta_tables() -> list[str]:
    return [t for t, _ in cta._child_columns()]


def cleanup(url: str, *argv: str, answer: str | None = None) -> tuple[int, str]:
    out = io.StringIO()

    def ask(prompt: str) -> str:
        if answer is None:
            raise AssertionError("must not prompt")
        return answer

    code = cta.main(list(argv), database_url=url, ask=ask, out=out)
    return code, out.getvalue()


@pytest.fixture
def populated(make_client: MakeClient, app_url: str) -> str:
    for email in ["e2e-1@example.com", "QA-2@EXAMPLE.COM", "pm40-probe@example.com", *REAL]:
        seed(make_client, email.lower())
    # A password reset link each (#350), written directly: the app has no email set up.
    run(
        _exec(
            app_url,
            "INSERT INTO password_reset_tokens (token_hash, user_id, expires_at) "
            "SELECT md5(id::text) || md5(email), id, now() + interval '1 hour' FROM users",
        )
    )
    age_all(app_url)
    run(_exec(app_url, "UPDATE users SET email = upper(email) WHERE email LIKE 'qa-2@%'"))
    return app_url


def test_every_user_fk_table_is_covered_by_the_report() -> None:
    assert set(cta_tables()) == {
        "user_settings",
        "auth_sessions",
        "focus_sessions",
        "custom_tags",
        "youtube_recent_links",
        "calendar_feeds",
        "password_reset_tokens",
    }
    assert Base.metadata.tables["calendar_feeds"] is not None


def test_ac2_matches_only_example_com_case_insensitively(populated: str) -> None:
    code, out = cleanup(populated)
    assert code == 0
    for e in ["e2e-1@example.com", "QA-2@EXAMPLE.COM", "pm40-probe@example.com"]:
        assert e in out
    for e in REAL:
        assert e not in out
    assert "Total: 3 account(s), 3 session(s), 3 custom tag(s), 3 link(s)" in out


def test_ac2_match_glob_narrows_on_the_local_part(populated: str) -> None:
    _, out = cleanup(populated, "--match", "qa*")
    assert "QA-2@EXAMPLE.COM" in out and "e2e-1" not in out and "pm40" not in out
    _, out = cleanup(populated, "--match", "*example*")  # the domain is not part of the glob
    assert "No matching" in out


def test_ac2_older_than_default_skips_recent_accounts(
    make_client: MakeClient, app_url: str
) -> None:
    seed(make_client, "fresh@example.com")
    _, out = cleanup(app_url)
    assert "No matching" in out
    assert "fresh@example.com" in cleanup(app_url, "--older-than", "0")[1]


def test_ac2_older_than_durations(make_client: MakeClient, app_url: str) -> None:
    seed(make_client, "a@example.com")
    run(_exec(app_url, "UPDATE users SET created_at = now() - interval '90 minutes'"))
    assert "No matching" in cleanup(app_url)[1]  # default 2h
    assert "a@example.com" in cleanup(app_url, "--older-than", "1h")[1]
    assert "No matching" in cleanup(app_url, "--older-than", "1d")[1]


@pytest.mark.parametrize(
    ("text", "delta"),
    [
        ("0", timedelta(0)),
        ("30m", timedelta(minutes=30)),
        ("2h", timedelta(hours=2)),
        ("1d", timedelta(days=1)),
        ("1w", timedelta(weeks=1)),
        ("90s", timedelta(seconds=90)),
    ],
)
def test_ac2_parse_duration(text: str, delta: timedelta) -> None:
    assert cta.parse_duration(text) == delta


def test_ac2_bad_duration_exits_nonzero(app_url: str) -> None:
    with pytest.raises(SystemExit) as e:
        cleanup(app_url, "--older-than", "soon")
    assert e.value.code != 0


def test_ac2_no_option_widens_the_domain(app_url: str) -> None:
    with pytest.raises(SystemExit) as e:
        cleanup(app_url, "--domain", "gmail.com")
    assert e.value.code != 0


def test_ac3_dry_run_changes_nothing_and_prints_a_table(populated: str) -> None:
    before_users, before_children = emails(populated), total_children(populated)
    code, out = cleanup(populated, "--older-than", "0")
    assert code == 0
    assert out.splitlines()[0].split() == ["Email", "Created", "(UTC)", "Sessions", "Tags", "Links"]
    assert "Dry run" in out
    assert emails(populated) == before_users
    assert total_children(populated) == before_children


def test_ac4_wrong_number_declines_and_deletes_nothing(populated: str) -> None:
    before = emails(populated)
    for wrong in ["2", "", "yes", "30"]:
        code, out = cleanup(populated, "--delete", answer=wrong)
        assert code != 0 and "nothing deleted" in out
    assert emails(populated) == before


def test_ac4_eof_at_the_prompt_declines(populated: str) -> None:
    def ask(_: str) -> str:
        raise EOFError

    code = cta.main(["--delete"], database_url=populated, ask=ask, out=io.StringIO())
    assert code != 0 and len(emails(populated)) == 3 + len(REAL)


def test_ac4_typing_the_count_deletes_and_cascades_to_every_table(populated: str) -> None:
    assert all(n == 3 + len(REAL) for n in total_children(populated).values())
    code, out = cleanup(populated, "--delete", answer="3")
    assert code == 0
    assert emails(populated) == sorted(REAL)
    for table in cta_tables():
        assert f"  {table}: 3" in out
    assert "  users: 3" in out
    # Only the real accounts' rows remain, in every child table.
    assert all(n == len(REAL) for n in total_children(populated).values())


def test_ac4_yes_skips_the_prompt_and_a_second_run_finds_nothing(populated: str) -> None:
    code, _ = cleanup(populated, "--delete", "--yes")
    assert code == 0
    code, out = cleanup(populated, "--delete", "--yes")
    assert code == 0 and "No matching" in out
    assert emails(populated) == sorted(REAL)


def test_ac4_delete_respects_match(populated: str) -> None:
    cleanup(populated, "--delete", "--yes", "--match", "e2e-*")
    left = emails(populated)
    assert "e2e-1@example.com" not in left and len(left) == 2 + len(REAL)


def test_ac5_look_alike_domains_survive_everything(populated: str) -> None:
    code, _ = cleanup(populated, "--delete", "--yes", "--older-than", "0", "--match", "*")
    assert code == 0
    assert emails(populated) == sorted(REAL)


def test_ac5_delete_rechecks_the_domain_itself(populated: str) -> None:
    ids = [r[0] for r in run(_query(populated, "SELECT id FROM users"))]
    removed = run(_delete_all(populated, ids))
    assert removed["users"] == 3
    assert emails(populated) == sorted(REAL)


async def _delete_all(url: str, ids: list[Any]) -> dict[str, int]:
    from app.db import create_engine

    engine = create_engine(url)
    try:
        return await cta.delete_accounts(engine, ids)
    finally:
        await engine.dispose()


def test_ac5_database_error_exits_nonzero(app_url: str, capsys: pytest.CaptureFixture[str]) -> None:
    bad = app_url.rsplit("/", 1)[0] + "/does_not_exist"
    code = cta.main([], database_url=bad, out=io.StringIO())
    assert code == cta.EXIT_ERROR
    err = capsys.readouterr().err
    assert err.strip().startswith("Error: ") and "does_not_exist" not in err


def test_ac1_runs_as_a_module_with_the_database_from_the_environment(populated: str) -> None:
    import os

    env = {**os.environ, "DATABASE_URL": populated}
    r = subprocess.run(
        [sys.executable, "-m", "app.cleanup_test_accounts", "--delete", "--yes"],
        cwd=BACKEND,
        env=env,
        capture_output=True,
        text=True,
        timeout=60,
        check=False,
    )
    assert r.returncode == 0, r.stderr
    assert emails(populated) == sorted(REAL)


def test_ac6_nothing_is_logged_and_goals_and_links_are_not_printed(
    populated: str, caplog: pytest.LogCaptureFixture
) -> None:
    with caplog.at_level(logging.DEBUG):
        _, out = cleanup(populated, "--delete", "--yes")
    assert "Write the report" not in out and "youtu.be" not in out
    assert not [r for r in caplog.records if r.name.startswith("app")]


def test_ac6_running_the_module_loads_no_opentelemetry(populated: str) -> None:
    import os

    code = (
        "import io, sys\n"
        "import app.cleanup_test_accounts as m\n"
        "rc = m.main(['--older-than', '0'], out=io.StringIO())\n"
        "bad = [k for k in sys.modules if k.startswith('opentelemetry')]\n"
        "sys.exit(rc or (9 if bad else 0))\n"
    )
    r = subprocess.run(
        [sys.executable, "-c", code],
        cwd=BACKEND,
        env={**os.environ, "DATABASE_URL": populated},
        capture_output=True,
        text=True,
        timeout=60,
        check=False,
    )
    assert r.returncode == 0, (r.returncode, r.stderr)


def test_empty_match_is_rejected_with_exit_2(populated: str) -> None:
    for glob in ["", "  "]:
        with pytest.raises(SystemExit) as e:
            cleanup(populated, "--delete", "--yes", "--match", glob)
        assert e.value.code == 2
    assert len(emails(populated)) == 3 + len(REAL)


def test_huge_older_than_is_rejected_with_exit_2(populated: str) -> None:
    for value in ["99999999999w", "999999999999999999999d"]:
        with pytest.raises(SystemExit) as e:
            cleanup(populated, "--older-than", value)
        assert e.value.code == 2


def test_ctrl_c_at_the_prompt_declines_without_a_traceback(populated: str) -> None:
    def ask(_: str) -> str:
        raise KeyboardInterrupt

    out = io.StringIO()
    code = cta.main(["--delete"], database_url=populated, ask=ask, out=out)
    assert code == 3 and "nothing deleted" in out.getvalue()
    assert len(emails(populated)) == 3 + len(REAL)


def test_control_characters_in_an_email_are_escaped(populated: str) -> None:
    run(
        _exec(
            populated,
            "UPDATE users SET email = E'x\\x1b[2J\\ny@example.com' WHERE email LIKE 'e2e-1@%'",
        )
    )
    _, out = cleanup(populated)
    assert "\x1b" not in out and "\r" not in out
    assert "x\\x1b[2J\\ny@example.com" in out


def test_fewer_deleted_than_confirmed_prints_a_warning(populated: str) -> None:
    import threading

    def ask(_: str) -> str:
        # Another process deletes one account while the operator is typing.
        t = threading.Thread(
            target=lambda: run(_exec(populated, "DELETE FROM users WHERE email LIKE 'e2e-1@%'"))
        )
        t.start()
        t.join()
        return "3"

    out = io.StringIO()
    code = cta.main(["--delete"], database_url=populated, ask=ask, out=out)
    assert code == 0
    assert "confirmed 3 account(s) but 2 were deleted" in out.getvalue()
    assert emails(populated) == sorted(REAL)


def test_deleted_report_order_matches_the_docs(populated: str) -> None:
    _, out = cleanup(populated, "--delete", "--yes")
    tables = [ln.split(":")[0].strip() for ln in out.splitlines() if ln.startswith("  ")]
    docs = (BACKEND.parent / "_docs" / "deployment.md").read_text()
    block = docs.split("Deleted:\n", 1)[1].split("```", 1)[0]
    assert [ln.split(":")[0].strip() for ln in block.splitlines() if ln] == tables


def test_ac3_backslash_is_escaped_unlike_a_real_escape_character() -> None:
    assert cta.printable("a\\x1b@example.com") == "a\\\\x1b@example.com"
    assert cta.printable("a\x1b@example.com") == "a\\x1b@example.com"
    assert cta.printable("plain@example.com") == "plain@example.com"


def test_ac2_one_real_sigint_at_the_prompt_exits_3_and_deletes_nothing(populated: str) -> None:
    import os
    import signal

    env = {**os.environ, "DATABASE_URL": populated, "PYTHONUNBUFFERED": "1"}
    p = subprocess.Popen(
        [sys.executable, "-u", "-m", "app.cleanup_test_accounts", "--delete"],
        cwd=BACKEND,
        env=env,
        stdin=subprocess.PIPE,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
    )
    try:
        assert p.stdout is not None
        seen = ""
        while "Type " not in seen:  # input() writes its prompt to stdout when not a tty
            ch = p.stdout.read(1)
            if not ch:
                break
            seen += ch
        assert "Total:" in seen
        p.send_signal(signal.SIGINT)
        stdout_rest, stderr = p.communicate(timeout=20)
    finally:
        if p.poll() is None:
            p.kill()
    assert p.returncode == 3, stderr
    assert "Traceback" not in stderr and "Traceback" not in stdout_rest
    assert "Not confirmed: nothing deleted." in stdout_rest
    assert len(emails(populated)) == 3 + len(REAL)


def test_bad_setting_prints_only_the_error_type() -> None:
    """AC: a settings error is reported like any other, with no traceback and no value."""
    env = {**os.environ, "READINESS_TIMEOUT_SECONDS": "not-a-number-xyz"}
    env.pop("DATABASE_URL", None)
    r = subprocess.run(
        [sys.executable, "-m", "app.cleanup_test_accounts"],
        cwd=BACKEND,
        env=env,
        capture_output=True,
        text=True,
        timeout=60,
    )
    assert r.returncode == 1, r.stderr
    assert r.stderr.strip() == "Error: ValidationError"
    assert "Traceback" not in r.stdout + r.stderr
    assert "not-a-number-xyz" not in r.stdout + r.stderr
