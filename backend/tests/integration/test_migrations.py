"""Alembic migrations and schema constraints against a real, throwaway Postgres."""

import uuid
from typing import Any

import pytest
from alembic import command
from alembic.autogenerate import compare_metadata
from alembic.config import Config
from alembic.migration import MigrationContext
from alembic.script import ScriptDirectory
from sqlalchemy import Connection, inspect, text
from sqlalchemy.exc import DBAPIError, IntegrityError
from sqlalchemy.ext.asyncio import create_async_engine

from app.models import Base
from tests.integration.conftest import run

pytestmark = pytest.mark.integration

TABLES = {"users", "user_settings", "focus_sessions", "youtube_recent_links"}


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


def test_single_migration_head(alembic_config: Config) -> None:
    assert len(ScriptDirectory.from_config(alembic_config).get_heads()) == 1


def test_models_match_migrations(alembic_config: Config, test_db_url: str) -> None:
    """No drift: autogenerate against the migrated database finds nothing to change."""
    command.upgrade(alembic_config, "head")

    def diff(conn: Connection) -> list[Any]:
        return list(compare_metadata(MigrationContext.configure(conn), Base.metadata))

    assert run(_with_conn(test_db_url, diff)) == []


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
    for tag in ("work", "study", "nap", "read", "meditation", "exercise"):
        _insert_session(db, tag=tag)
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
                "default_reminder_minutes FROM user_settings"
            )
        ).one()

    row = run(_with_conn(db, read))
    assert tuple(row) == (0, 80, 50, False, None)  # Sunday, reminders Off (AC10.6, AC4.2)
    for bad in (
        "week_start_day = 7",
        "alert_volume = 101",
        "default_reminder_minutes = 20",
        "last_tag = 'Gaming'",
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
