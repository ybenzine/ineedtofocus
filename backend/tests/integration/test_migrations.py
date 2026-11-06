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
    "password_reset_tokens",
    "custom_tags",
    "calendar_feeds",
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


def test_youtube_title_column_is_nullable_and_old_rows_keep_null(
    alembic_config: Config, test_db_url: str
) -> None:
    """0004 (#326) is expand-only: a nullable column, old rows get NULL; it rolls back."""
    command.upgrade(alembic_config, "0003")
    run(
        _exec(
            test_db_url,
            "INSERT INTO users (id, email, password_hash) VALUES (:u, 'a@b.c', 'x')",
            u=USER,
        )
    )
    run(
        _exec(
            test_db_url,
            "INSERT INTO youtube_recent_links (user_id, url) VALUES (:u, 'https://youtu.be/x')",
            u=USER,
        )
    )
    command.upgrade(alembic_config, "head")

    def title(conn: Connection) -> Any:
        return conn.execute(text("SELECT title FROM youtube_recent_links")).scalar_one()

    assert run(_with_conn(test_db_url, title)) is None
    command.downgrade(alembic_config, "0003")
    command.upgrade(alembic_config, "head")


def test_countdown_recent_minutes_is_nullable_and_the_previous_release_ignores_it(
    alembic_config: Config, test_db_url: str
) -> None:
    """0006 (#408) is expand-only: nullable, no default, checked 1-240; it rolls back."""
    command.upgrade(alembic_config, "0005")
    run(
        _exec(
            test_db_url,
            "INSERT INTO users (id, email, password_hash) VALUES (:u, 'a@b.c', 'x')",
            u=USER,
        )
    )
    run(_exec(test_db_url, "INSERT INTO user_settings (user_id) VALUES (:u)", u=USER))
    command.upgrade(alembic_config, "0006")

    def read(conn: Connection) -> Any:
        return conn.execute(text("SELECT countdown_recent_minutes FROM user_settings")).scalar_one()

    assert run(_with_conn(test_db_url, read)) is None

    # The previous release's statements name the old columns only and still work.
    run(_exec(test_db_url, "UPDATE user_settings SET keep_screen_awake = true, theme = 'dark'"))
    other = "00000000-0000-0000-0000-0000000000b2"
    run(
        _exec(
            test_db_url,
            "INSERT INTO users (id, email, password_hash) VALUES (:u, 'd@e.f', 'x')",
            u=other,
        )
    )
    run(_exec(test_db_url, "INSERT INTO user_settings (user_id) VALUES (:u)", u=other))
    for bad in (0, 241):
        with pytest.raises((IntegrityError, DBAPIError)):
            run(_exec(test_db_url, f"UPDATE user_settings SET countdown_recent_minutes = {bad}"))
    run(_exec(test_db_url, "UPDATE user_settings SET countdown_recent_minutes = 240"))

    command.downgrade(alembic_config, "0005")

    def columns(conn: Connection) -> Any:
        return {c["name"] for c in inspect(conn).get_columns("user_settings")}

    assert "countdown_recent_minutes" not in run(_with_conn(test_db_url, columns))
    command.upgrade(alembic_config, "head")


def test_pause_audio_on_breaks_existing_rows_read_true_and_it_rolls_back(
    alembic_config: Config, test_db_url: str
) -> None:
    """0008 (#370, AC12.6) is expand-only: rows made before it read true; it rolls back."""
    command.upgrade(alembic_config, "0007")
    run(
        _exec(
            test_db_url,
            "INSERT INTO users (id, email, password_hash) VALUES (:u, 'a@b.c', 'x')",
            u=USER,
        )
    )
    run(_exec(test_db_url, "INSERT INTO user_settings (user_id) VALUES (:u)", u=USER))
    command.upgrade(alembic_config, "0008")

    def read(conn: Connection) -> Any:
        return conn.execute(text("SELECT pause_audio_on_breaks FROM user_settings")).scalar_one()

    assert run(_with_conn(test_db_url, read)) is True
    # The previous release's statements leave the column alone and still work.
    run(_exec(test_db_url, "UPDATE user_settings SET keep_screen_awake = true"))
    command.downgrade(alembic_config, "0007")

    def columns(conn: Connection) -> Any:
        return {c["name"] for c in inspect(conn).get_columns("user_settings")}

    assert "pause_audio_on_breaks" not in run(_with_conn(test_db_url, columns))
    command.upgrade(alembic_config, "head")
    assert run(_with_conn(test_db_url, read)) is True


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
    column = Base.metadata.tables["user_settings"].c.week_start_day
    monkeypatch.setattr(column, "server_default", DefaultClause(text("99")))
    problems = run(_with_conn(test_db_url, drift))
    assert any("week_start_day" in p for p in problems)


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
                "SELECT week_start_day, keep_screen_awake, "
                "default_reminder_minutes, theme, countdown_recent_minutes FROM user_settings"
            )
        ).one()

    row = run(_with_conn(db, read))
    assert tuple(row) == (
        0,
        False,
        None,
        "system",
        None,
    )  # Sunday, reminders Off, follow the device
    for bad in (
        "week_start_day = 7",
        "default_reminder_minutes = 20",
        "last_tag = 'Gaming'",
        "theme = 'sepia'",
        "theme = NULL",
        "countdown_recent_minutes = 0",
        "countdown_recent_minutes = 241",
    ):
        with pytest.raises((IntegrityError, DBAPIError)):
            run(_exec(db, f"UPDATE user_settings SET {bad}"))


def test_calendar_export_migration_0007_adds_defaults_and_rolls_back(
    alembic_config: Config, test_db_url: str
) -> None:
    """0007 (#381) is expand-only: existing settings rows get the defaults, the checks hold,
    `calendar_feeds` cascades with the user, and it rolls back."""
    command.upgrade(alembic_config, "0006")
    run(
        _exec(
            test_db_url,
            "INSERT INTO users (id, email, password_hash) VALUES (:u, 'a@b.c', 'x')",
            u=USER,
        )
    )
    run(_exec(test_db_url, "INSERT INTO user_settings (user_id) VALUES (:u)", u=USER))
    command.upgrade(alembic_config, "head")

    def read(conn: Connection) -> Any:
        return tuple(
            conn.execute(
                text(
                    "SELECT calendar_title_template, calendar_include_goal, "
                    "calendar_include_description, calendar_excluded_tags::text, "
                    "calendar_min_minutes, calendar_name FROM user_settings"
                )
            ).one()
        )

    assert run(_with_conn(test_db_url, read)) == (
        "{tag}: {goal}",
        True,
        True,
        "[]",
        0,
        "I Need To Focus",
    )
    for bad in (
        "calendar_title_template = repeat('x', 121)",
        "calendar_name = ''",
        "calendar_name = repeat('x', 61)",
        "calendar_min_minutes = 7",
        "calendar_excluded_tags = '{}'::jsonb",
        "calendar_title_template = NULL",
    ):
        with pytest.raises((IntegrityError, DBAPIError)):
            run(_exec(test_db_url, f"UPDATE user_settings SET {bad}"))
    run(_exec(test_db_url, "UPDATE user_settings SET calendar_min_minutes = 15"))

    insert = "INSERT INTO calendar_feeds (user_id, token_hash) VALUES (:u, :h)"
    run(_exec(test_db_url, insert, u=USER, h="a" * 64))
    with pytest.raises((IntegrityError, DBAPIError)):  # one feed per user
        run(_exec(test_db_url, insert, u=USER, h="b" * 64))
    run(_exec(test_db_url, f"DELETE FROM users WHERE id = '{USER}'"))

    def feeds(conn: Connection) -> Any:
        return conn.execute(text("SELECT count(*) FROM calendar_feeds")).scalar_one()

    assert run(_with_conn(test_db_url, feeds)) == 0  # ON DELETE CASCADE

    command.downgrade(alembic_config, "0006")

    def shape(conn: Connection) -> Any:
        inspector = inspect(conn)
        return (
            "calendar_feeds" in inspector.get_table_names(),
            {c["name"] for c in inspector.get_columns("user_settings")},
        )

    has_table, columns = run(_with_conn(test_db_url, shape))
    assert not has_table
    assert not {c for c in columns if c.startswith("calendar_")}
    command.upgrade(alembic_config, "head")


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


def test_430_migration_0009_drops_the_volume_columns_and_round_trips(
    alembic_config: Config, test_db_url: str
) -> None:
    """0009 (#430) is the first contract migration: it drops both columns; downgrade puts them
    back with the old defaults and checks; upgrading again works."""
    command.upgrade(alembic_config, "0008")
    run(
        _exec(
            test_db_url,
            "INSERT INTO users (id, email, password_hash) VALUES (:u, 'a@b.c', 'x')",
            u=USER,
        )
    )
    run(_exec(test_db_url, "INSERT INTO user_settings (user_id) VALUES (:u)", u=USER))
    run(_exec(test_db_url, "UPDATE user_settings SET alert_volume = 5, background_volume = 6"))

    def columns(conn: Connection) -> Any:
        return {c["name"] for c in inspect(conn).get_columns("user_settings")}

    def checks(conn: Connection) -> Any:
        return {c["name"] for c in inspect(conn).get_check_constraints("user_settings")}

    volumes = {"alert_volume", "background_volume"}
    assert volumes <= run(_with_conn(test_db_url, columns))

    command.upgrade(alembic_config, "0009")
    assert not volumes & run(_with_conn(test_db_url, columns))
    assert not {"ck_user_settings_alert_volume", "ck_user_settings_background_volume"} & run(
        _with_conn(test_db_url, checks)
    )
    # The row and the other settings survive.
    count = run(
        _with_conn(
            test_db_url,
            lambda c: c.execute(text("SELECT count(*) FROM user_settings")).scalar_one(),
        )
    )
    assert count == 1

    command.downgrade(alembic_config, "0008")
    assert volumes <= run(_with_conn(test_db_url, columns))

    def read(conn: Connection) -> Any:
        return tuple(
            conn.execute(text("SELECT alert_volume, background_volume FROM user_settings")).one()
        )

    assert run(_with_conn(test_db_url, read)) == (80, 50)  # the old defaults
    for bad in ("alert_volume = 101", "background_volume = -1"):
        with pytest.raises((IntegrityError, DBAPIError)):
            run(_exec(test_db_url, f"UPDATE user_settings SET {bad}"))

    command.upgrade(alembic_config, "head")
    assert not volumes & run(_with_conn(test_db_url, columns))


def test_430_model_selects_and_inserts_with_and_without_the_volume_columns(
    alembic_config: Config, test_db_url: str
) -> None:
    """The model does not map alert_volume/background_volume (#446). At 0008, where the columns
    still exist, a select and an insert through the model work and the database fills the NOT
    NULL columns from their server defaults (80, 50). At 0009/head, where they are gone, the
    same statements work too."""
    from sqlalchemy import select
    from sqlalchemy.ext.asyncio import AsyncSession

    from app.models import User, UserSettings

    async def go(email: str) -> int:
        engine = create_async_engine(test_db_url)
        try:
            async with AsyncSession(engine, expire_on_commit=False) as session:
                user = User(email=email, password_hash="x")
                session.add(user)
                await session.flush()
                session.add(UserSettings(user_id=user.id))
                await session.commit()
                rows = (await session.execute(select(UserSettings))).scalars().all()
                return len(rows)
        finally:
            await engine.dispose()

    def volumes(conn: Connection) -> Any:
        return [
            tuple(r)
            for r in conn.execute(text("SELECT alert_volume, background_volume FROM user_settings"))
        ]

    command.upgrade(alembic_config, "0008")
    assert run(go("a@b.c")) == 1
    assert run(_with_conn(test_db_url, volumes)) == [(80, 50)]  # filled by the server defaults

    command.upgrade(alembic_config, "head")
    assert run(go("d@e.f")) == 2
