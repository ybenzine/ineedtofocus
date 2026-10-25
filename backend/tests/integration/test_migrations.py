"""Alembic migrations and schema constraints against a real, throwaway Postgres."""

import logging
import re
import uuid
from typing import Any

import pytest
from alembic import command
from alembic.autogenerate import compare_metadata
from alembic.config import Config
from alembic.migration import MigrationContext
from alembic.script import ScriptDirectory
from sqlalchemy import CheckConstraint, Connection, DefaultClause, inspect, text
from sqlalchemy.exc import DBAPIError, IntegrityError
from sqlalchemy.ext.asyncio import create_async_engine

from app.db import create_engine
from app.logging_config import JsonFormatter
from app.models import MODES, STATUSES, TAGS, Base
from app.models.enums import in_list
from tests.integration.conftest import run

pytestmark = pytest.mark.integration

TABLES = {
    "users",
    "user_settings",
    "focus_sessions",
    "youtube_recent_links",
    "auth_sessions",
}


async def _tables(url: str) -> set[str]:
    engine = create_async_engine(url)
    try:
        async with engine.connect() as conn:
            names = await conn.run_sync(lambda c: set(inspect(c).get_table_names()))
    finally:
        await engine.dispose()
    return names - {"alembic_version"}


async def _with_conn(url: str, fn: Any) -> Any:
    engine = create_async_engine(url)
    try:
        async with engine.connect() as conn:
            return await conn.run_sync(fn)
    finally:
        await engine.dispose()


async def _exec(db_url: str, sql: str, **params: Any) -> None:
    engine = create_async_engine(db_url)
    try:
        async with engine.begin() as conn:
            await conn.execute(text(sql), params)
    finally:
        await engine.dispose()


# --- upgrade / downgrade -------------------------------------------------------


def test_ac_upgrade_creates_all_tables(alembic_config: Config, test_db_url: str) -> None:
    command.upgrade(alembic_config, "head")
    assert run(_tables(test_db_url)) == TABLES


def test_ac_downgrade_removes_all_tables(alembic_config: Config, test_db_url: str) -> None:
    command.upgrade(alembic_config, "head")
    command.downgrade(alembic_config, "base")
    assert run(_tables(test_db_url)) == set()


def test_upgrade_is_repeatable_and_idempotent_at_head(
    alembic_config: Config, test_db_url: str
) -> None:
    command.upgrade(alembic_config, "head")
    command.upgrade(alembic_config, "head")  # no-op, as on every deploy
    command.downgrade(alembic_config, "base")
    command.upgrade(alembic_config, "head")
    assert run(_tables(test_db_url)) == TABLES


def test_theme_column_is_added_to_existing_rows_as_system(
    alembic_config: Config, test_db_url: str
) -> None:
    """0003 (#214) is expand-only: existing rows get the default; it rolls back."""
    command.upgrade(alembic_config, "0002")
    run(
        _exec(
            test_db_url,
            "INSERT INTO users (id, email, password_hash) VALUES (:u, 'a@b.c', 'x')",
            u=USER,
        )
    )
    run(_exec(test_db_url, "INSERT INTO user_settings (user_id) VALUES (:u)", u=USER))
    command.upgrade(alembic_config, "head")

    def theme(conn: Connection) -> Any:
        return conn.execute(text("SELECT theme FROM user_settings")).scalar_one()

    assert run(_with_conn(test_db_url, theme)) == "system"
    command.downgrade(alembic_config, "0002")
    command.upgrade(alembic_config, "head")


def test_single_migration_head(alembic_config: Config) -> None:
    assert len(ScriptDirectory.from_config(alembic_config).get_heads()) == 1


_QUOTED = re.compile(r"'([^']*)'")
_NUMBER = re.compile(r"(?<![\w.])\d+(?![\w.])")


def _tokens(sql: str) -> tuple[set[str], set[str]]:
    """Quoted literals and bare numbers in a CHECK expression (spelling-independent)."""
    return set(_QUOTED.findall(sql)), set(_NUMBER.findall(_QUOTED.sub("", sql)))


def drift(conn: Connection) -> list[str]:
    """Differences between the models and the migrated database.

    Alembic's own diff (with server defaults) plus CHECK constraints, which Alembic does
    not compare: names and the allowed-value/number sets must match the model.
    """
    problems = [
        str(d)
        for d in compare_metadata(
            MigrationContext.configure(conn, opts={"compare_server_default": True}),
            Base.metadata,
        )
    ]
    insp = inspect(conn)
    for table in Base.metadata.sorted_tables:
        in_db = {str(c["name"]): c["sqltext"] for c in insp.get_check_constraints(table.name)}
        in_model = {
            str(c.name): str(c.sqltext) for c in table.constraints if isinstance(c, CheckConstraint)
        }
        declared = [c.name for c in table.constraints if isinstance(c, CheckConstraint)]
        for name in sorted({n for n in declared if declared.count(n) > 1}, key=str):
            problems.append(f"{table.name}: CHECK {name} is declared more than once")
        if set(in_db) != set(in_model):
            names = sorted(set(in_db) ^ set(in_model))
            problems.append(f"{table.name}: CHECK names differ: {names}")
        for name in in_db.keys() & in_model.keys():
            if _tokens(in_db[name]) != _tokens(in_model[name]):
                problems.append(f"{table.name}.{name}: CHECK differs: {in_db[name]}")
    return problems


def test_models_match_migrations(alembic_config: Config, test_db_url: str) -> None:
    """No drift: columns, defaults, indexes and CHECK constraints all match."""
    command.upgrade(alembic_config, "head")
    assert run(_with_conn(test_db_url, drift)) == []


def test_drift_detects_changed_allowed_tags(
    alembic_config: Config, test_db_url: str, monkeypatch: pytest.MonkeyPatch
) -> None:
    command.upgrade(alembic_config, "head")
    table = Base.metadata.tables["focus_sessions"]
    check = next(
        c for c in table.constraints if getattr(c, "name", None) == "ck_focus_sessions_tag"
    )
    monkeypatch.setattr(check, "sqltext", text(in_list("tag", (*TAGS, "gaming"))))
    problems = run(_with_conn(test_db_url, drift))
    assert any("ck_focus_sessions_tag" in p for p in problems)


def test_drift_detects_a_check_declared_twice(alembic_config: Config, test_db_url: str) -> None:
    command.upgrade(alembic_config, "head")
    table = Base.metadata.tables["user_settings"]
    duplicate = CheckConstraint(in_list("theme", ("system", "dark", "light")), name="theme")
    table.append_constraint(duplicate)
    try:
        problems = run(_with_conn(test_db_url, drift))
    finally:
        table.constraints.discard(duplicate)
    assert any("declared more than once" in p for p in problems)


def test_drift_detects_changed_default(
    alembic_config: Config, test_db_url: str, monkeypatch: pytest.MonkeyPatch
) -> None:
    command.upgrade(alembic_config, "head")
    column = Base.metadata.tables["user_settings"].c.alert_volume
    monkeypatch.setattr(column, "server_default", DefaultClause(text("99")))
    problems = run(_with_conn(test_db_url, drift))
    assert any("alert_volume" in p for p in problems)


# --- constraints ---------------------------------------------------------------

USER = "00000000-0000-0000-0000-0000000000a1"
OTHER = "00000000-0000-0000-0000-0000000000a2"


@pytest.fixture
def db(alembic_config: Config, test_db_url: str) -> str:
    command.upgrade(alembic_config, "head")
    run(
        _exec(
            test_db_url,
            "INSERT INTO users (id, email, password_hash) VALUES "
            f"('{USER}', 'a@example.com', 'x'), ('{OTHER}', 'b@example.com', 'x')",
        )
    )
    return test_db_url


def _insert_session(url: str, **overrides: Any) -> None:
    values: dict[str, Any] = {
        "id": str(uuid.uuid4()),
        "user_id": USER,
        "mode": "countdown",
        "tag": "work",
        "goal": None,
        "focus_seconds": 1500,
        "status": "completed",
    }
    values.update(overrides)
    run(
        _exec(
            url,
            "INSERT INTO focus_sessions (id, user_id, mode, tag, goal, started_at, ended_at, "
            "focus_seconds, status, blocks_completed) VALUES (:id, :user_id, :mode, :tag, :goal, "
            "now() - interval '30 minutes', now(), :focus_seconds, :status, "
            f"{values.pop('blocks_completed', 0)})",
            **values,
        )
    )


def test_ac7_1_valid_session_is_accepted(db: str) -> None:
    for tag in TAGS:
        _insert_session(db, tag=tag)
    for mode in MODES:
        _insert_session(db, mode=mode)
    for status in STATUSES:
        _insert_session(db, status=status)
    _insert_session(db, mode="pomodoro", status="ended_early", blocks_completed=2)


@pytest.mark.parametrize(
    "overrides",
    [
        {"tag": "Gaming"},
        {"tag": "Work"},  # stored lower-case
        {"mode": "stopwatch"},
        {"status": "abandoned"},
        {"focus_seconds": -1},
        {"blocks_completed": -1},
    ],
    ids=["tag", "tag-case", "mode", "status", "negative-focus", "negative-blocks"],
)
def test_ac_constraints_reject_disallowed_values(db: str, overrides: dict[str, Any]) -> None:
    with pytest.raises((IntegrityError, DBAPIError)):
        _insert_session(db, **overrides)


def test_ac7_3_goal_of_120_chars_ok_121_rejected(db: str) -> None:
    _insert_session(db, goal="x" * 120)
    with pytest.raises((IntegrityError, DBAPIError)):
        _insert_session(db, goal="x" * 121)


def test_ac13_4_duplicate_client_uuid_is_rejected(db: str) -> None:
    sid = str(uuid.uuid4())
    _insert_session(db, id=sid)
    with pytest.raises((IntegrityError, DBAPIError)):
        _insert_session(db, id=sid)


def test_session_cannot_end_before_it_starts(db: str) -> None:
    with pytest.raises((IntegrityError, DBAPIError)):
        run(
            _exec(
                db,
                "INSERT INTO focus_sessions (id, user_id, mode, tag, started_at, ended_at, "
                "focus_seconds, status) VALUES (:id, :u, 'countdown', 'work', now(), "
                "now() - interval '1 hour', 0, 'completed')",
                id=str(uuid.uuid4()),
                u=USER,
            )
        )


def test_session_requires_existing_user(db: str) -> None:
    with pytest.raises((IntegrityError, DBAPIError)):
        _insert_session(db, user_id=str(uuid.uuid4()))


def test_emails_are_unique_case_insensitively(db: str) -> None:
    with pytest.raises((IntegrityError, DBAPIError)):
        run(
            _exec(
                db,
                "INSERT INTO users (email, password_hash) VALUES ('A@Example.com', 'x')",
            )
        )


def test_settings_defaults_and_ranges(db: str) -> None:
    run(_exec(db, f"INSERT INTO user_settings (user_id) VALUES ('{USER}')"))

    def read(conn: Connection) -> Any:
        return conn.execute(
            text(
                "SELECT week_start_day, alert_volume, background_volume, keep_screen_awake, "
                "default_reminder_minutes, theme FROM user_settings"
            )
        ).one()

    row = run(_with_conn(db, read))
    assert tuple(row) == (
        0,
        80,
        50,
        False,
        None,
        "system",
    )  # Sunday, reminders Off, follow the device
    for bad in (
        "week_start_day = 7",
        "alert_volume = 101",
        "default_reminder_minutes = 20",
        "last_tag = 'Gaming'",
        "theme = 'sepia'",
        "theme = NULL",
    ):
        with pytest.raises((IntegrityError, DBAPIError)):
            run(_exec(db, f"UPDATE user_settings SET {bad}"))


def test_youtube_links_unique_per_user(db: str) -> None:
    sql = "INSERT INTO youtube_recent_links (user_id, url) VALUES (:u, :url)"
    run(_exec(db, sql, u=USER, url="https://youtu.be/abc"))
    run(_exec(db, sql, u=OTHER, url="https://youtu.be/abc"))  # other user: fine
    with pytest.raises((IntegrityError, DBAPIError)):
        run(_exec(db, sql, u=USER, url="https://youtu.be/abc"))


def test_deleting_a_user_removes_their_rows(db: str) -> None:
    _insert_session(db)
    run(_exec(db, f"DELETE FROM users WHERE id = '{USER}'"))

    def count(conn: Connection) -> int:
        return int(conn.execute(text("SELECT count(*) FROM focus_sessions")).scalar_one())

    assert run(_with_conn(db, count)) == 0


# --- indexes -------------------------------------------------------------------


def test_ac_history_indexes_exist_and_are_used(db: str) -> None:
    def names(conn: Connection) -> set[str]:
        return {i["name"] for i in inspect(conn).get_indexes("focus_sessions")}  # type: ignore[misc]

    assert {
        "ix_focus_sessions_user_started",
        "ix_focus_sessions_user_tag_started",
        "ix_focus_sessions_user_archived",
    } <= run(_with_conn(db, names))

    def plan(conn: Connection) -> str:
        conn.execute(text("SET enable_seqscan = off"))
        rows = conn.execute(
            text(
                "EXPLAIN SELECT * FROM focus_sessions WHERE user_id = :u "
                "ORDER BY started_at DESC LIMIT 20"
            ),
            {"u": USER},
        )
        return "\n".join(r[0] for r in rows)

    assert "ix_focus_sessions_user_started" in run(_with_conn(db, plan))


def test_database_errors_do_not_leak_parameters(db: str) -> None:
    """A logged duplicate-email IntegrityError must not contain the email (privacy)."""
    email = "private.person@example.com"
    sql = "INSERT INTO users (email, password_hash) VALUES (:e, 'x')"

    async def attempt() -> BaseException:
        engine = create_engine(db)
        try:
            async with engine.begin() as conn:
                await conn.execute(text(sql), {"e": email})
            async with engine.begin() as conn:
                await conn.execute(text(sql), {"e": email})
        except IntegrityError as exc:
            return exc
        finally:
            await engine.dispose()
        raise AssertionError("expected IntegrityError")

    exc = run(attempt())
    # SQLAlchemy hides the statement parameters ...
    assert email not in str(exc)
    # ... and the Postgres DETAIL line (which quotes the row) is scrubbed by our log formatter.
    record = logging.LogRecord(
        "test",
        logging.ERROR,
        __file__,
        1,
        "db error: %s",
        (exc,),
        (type(exc), exc, exc.__traceback__),
    )
    logged = JsonFormatter().format(record)
    assert email not in logged
    assert email.split("@")[0] not in logged
    assert "IntegrityError" in logged  # still useful for diagnosis
