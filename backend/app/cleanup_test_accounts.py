"""Delete throwaway test accounts and their data (#423).

Run inside the app container, which already has the database settings:

    docker exec -it focus-dev-app-1 python -m app.cleanup_test_accounts [--delete]

Only accounts whose email ends in `@example.com` (RFC 2606, so no real person can sign up
with it) are ever listed or deleted; no option widens that. Without `--delete` it is a dry
run. Deletion is `DELETE FROM users`, and ON DELETE CASCADE removes everything else, the same
as account deletion (AC1.7).

Privacy: emails are printed to the operator's terminal only. Nothing here uses logging,
OpenTelemetry or metrics (the app's telemetry is never started), and goals and links are
counted, never printed.
"""

import argparse
import asyncio
import fnmatch
import re
import sys
import uuid
from collections.abc import Callable, Sequence
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta
from typing import TextIO

from sqlalchemy import delete, func, select
from sqlalchemy.ext.asyncio import AsyncConnection, AsyncEngine

from app.config import Settings
from app.db import create_engine
from app.models import Base, CustomTag, FocusSession, User, YoutubeRecentLink

TEST_DOMAIN = "@example.com"
DEFAULT_OLDER_THAN = "2h"

_UNITS = {"s": 1, "m": 60, "h": 3600, "d": 86400, "w": 604800}
MAX_OLDER_THAN_SECONDS = 100 * 365 * 86400
_DURATION = re.compile(r"(\d+)([smhdw])")

EXIT_OK = 0
EXIT_ERROR = 1
# 2 is argparse's own code for bad arguments
EXIT_DECLINED = 3


def parse_duration(value: str) -> timedelta:
    """`2h`, `30m`, `1d`, `1w`, `90s`; `0` means no minimum age."""
    if value == "0":
        return timedelta(0)
    m = _DURATION.fullmatch(value.strip().lower())
    if m is None:
        raise argparse.ArgumentTypeError(f"not a duration: {value!r} (use e.g. 30m, 2h, 1d, or 0)")
    seconds = int(m.group(1)) * _UNITS[m.group(2)]
    if seconds > MAX_OLDER_THAN_SECONDS:
        raise argparse.ArgumentTypeError(f"too long: {value!r} (at most 100 years)")
    return timedelta(seconds=seconds)


def parse_glob(value: str) -> str:
    if not value.strip():
        raise argparse.ArgumentTypeError("--match must not be empty (omit it to match everything)")
    return value


def printable(text: str) -> str:
    """Escape control characters and backslashes, so an email can't fake an escape code."""
    return "".join(
        c if c.isprintable() and c != "\\" else c.encode("unicode_escape").decode() for c in text
    )


@dataclass(frozen=True)
class Account:
    id: uuid.UUID
    email: str
    created_at: datetime
    sessions: int
    tags: int
    links: int


def is_test_email(email: str) -> bool:
    return email.lower().endswith(TEST_DOMAIN)


def _child_columns() -> list[tuple[str, str]]:
    """(table, column) for every table with a foreign key to users.id, from the models."""
    found: list[tuple[str, str]] = []
    for table in Base.metadata.sorted_tables:
        for col in table.columns:
            for fk in col.foreign_keys:
                if fk.column.table.name == "users":
                    found.append((table.name, col.name))
    return found


async def _count(conn: AsyncConnection, table: str, column: str, ids: list[uuid.UUID]) -> int:
    t = Base.metadata.tables[table]
    n = await conn.scalar(select(func.count()).select_from(t).where(t.c[column].in_(ids)))
    return int(n or 0)


async def find_accounts(
    conn: AsyncConnection, *, match: str | None, older_than: timedelta, now: datetime | None = None
) -> list[Account]:
    cutoff = (now or datetime.now(UTC)) - older_than
    rows = (
        await conn.execute(
            select(User.id, User.email, User.created_at)
            .where(func.lower(User.email).like("%" + TEST_DOMAIN), User.created_at <= cutoff)
            .order_by(User.created_at, User.email)
        )
    ).all()
    pattern = match.lower() if match else None
    kept = [
        r
        for r in rows
        if is_test_email(r.email)  # belt and braces: the SQL filter is not the only guard
        and (pattern is None or fnmatch.fnmatchcase(r.email.lower().rpartition("@")[0], pattern))
    ]
    if not kept:
        return []
    ids = [r.id for r in kept]

    async def per_user(model: type[Base]) -> dict[uuid.UUID, int]:
        col = model.__table__.c.user_id
        out = await conn.execute(select(col, func.count()).where(col.in_(ids)).group_by(col))
        return {uid: n for uid, n in out.all()}

    sessions = await per_user(FocusSession)
    tags = await per_user(CustomTag)
    links = await per_user(YoutubeRecentLink)
    return [
        Account(
            r.id,
            r.email,
            r.created_at,
            sessions.get(r.id, 0),
            tags.get(r.id, 0),
            links.get(r.id, 0),
        )
        for r in kept
    ]


def render_table(accounts: Sequence[Account]) -> str:
    headers = ("Email", "Created (UTC)", "Sessions", "Tags", "Links")
    rows = [
        (
            printable(a.email),
            a.created_at.astimezone(UTC).strftime("%Y-%m-%d %H:%M"),
            str(a.sessions),
            str(a.tags),
            str(a.links),
        )
        for a in accounts
    ]
    widths = [max(len(r[i]) for r in [headers, *rows]) for i in range(len(headers))]

    def line(r: Sequence[str]) -> str:
        return "  ".join(
            c.ljust(widths[i]) if i < 2 else c.rjust(widths[i]) for i, c in enumerate(r)
        ).rstrip()

    out = [line(headers), line(["-" * w for w in widths])]
    out += [line(r) for r in rows]
    out.append(
        f"Total: {len(accounts)} account(s), {sum(a.sessions for a in accounts)} session(s), "
        f"{sum(a.tags for a in accounts)} custom tag(s), {sum(a.links for a in accounts)} link(s)"
    )
    return "\n".join(out)


async def delete_accounts(engine: AsyncEngine, ids: list[uuid.UUID]) -> dict[str, int]:
    """Delete in one transaction; return rows removed per table (users first)."""
    removed: dict[str, int] = {}
    async with engine.begin() as conn:
        # Re-check the domain in the query itself: only example.com rows can go.
        safe_ids = list(
            (
                await conn.scalars(
                    select(User.id).where(
                        User.id.in_(ids), func.lower(User.email).like("%" + TEST_DOMAIN)
                    )
                )
            ).all()
        )
        if not safe_ids:
            return {"users": 0}
        for table, column in _child_columns():
            removed[table] = await _count(conn, table, column, safe_ids)
        result = await conn.execute(delete(User).where(User.id.in_(safe_ids)))
        removed = {"users": result.rowcount, **removed}
    return removed


def build_parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(
        prog="python -m app.cleanup_test_accounts",
        description="List (default) or delete test accounts: emails ending in @example.com.",
    )
    p.add_argument(
        "--match", metavar="GLOB", type=parse_glob, help="only emails whose part before @ matches"
    )
    p.add_argument(
        "--older-than",
        metavar="DURATION",
        type=parse_duration,
        default=parse_duration(DEFAULT_OLDER_THAN),
        help=f"skip accounts created more recently (default {DEFAULT_OLDER_THAN}; 0 = all)",
    )
    p.add_argument("--delete", action="store_true", help="delete them (default: dry run)")
    p.add_argument("--yes", action="store_true", help="with --delete, skip the confirmation")
    return p


async def list_phase(args: argparse.Namespace, database_url: str, out: TextIO) -> list[Account]:
    """Phase 1: find and print the matching accounts, then close the engine."""
    engine = create_engine(database_url)
    try:
        async with engine.connect() as conn:
            accounts = await find_accounts(conn, match=args.match, older_than=args.older_than)
    finally:
        await engine.dispose()
    if not accounts:
        print("No matching test accounts.", file=out)
        return []
    print(render_table(accounts), file=out)
    return accounts


async def delete_phase(accounts: list[Account], database_url: str, out: TextIO) -> None:
    """Phase 3: delete in one transaction and print what went."""
    engine = create_engine(database_url)
    try:
        removed = await delete_accounts(engine, [a.id for a in accounts])
    finally:
        await engine.dispose()
    if removed["users"] != len(accounts):
        print(
            f"Warning: you confirmed {len(accounts)} account(s) but {removed['users']} "
            "were deleted (the rest changed or went in the meantime).",
            file=out,
        )
    print("Deleted:", file=out)
    for table, n in removed.items():
        print(f"  {table}: {n}", file=out)


def main(
    argv: Sequence[str] | None = None,
    *,
    database_url: str | None = None,
    ask: Callable[[str], str] = input,
    out: TextIO | None = None,
) -> int:
    args = build_parser().parse_args(argv)
    out = out or sys.stdout
    url = database_url or Settings().database_url
    try:
        # The prompt runs between two asyncio.run calls, with no event loop: asyncio.run
        # installs its own SIGINT handler, which would swallow the first Ctrl-C at the prompt.
        accounts = asyncio.run(list_phase(args, url, out))
        if not accounts:
            return EXIT_OK
        if not args.delete:
            print("Dry run: nothing changed. Add --delete to remove them.", file=out)
            return EXIT_OK
        if not args.yes:
            try:
                answer = ask(f"Type {len(accounts)} to delete these accounts and all their data: ")
            except (EOFError, KeyboardInterrupt):
                answer = ""
            if answer.strip() != str(len(accounts)):
                print("Not confirmed: nothing deleted.", file=out)
                return EXIT_DECLINED
        asyncio.run(delete_phase(accounts, url, out))
        return EXIT_OK
    except KeyboardInterrupt:
        print("Interrupted: nothing more was changed.", file=sys.stderr)
        return EXIT_DECLINED
    except Exception as exc:  # type only: a message could carry a URL or an email
        print(f"Error: {type(exc).__name__}", file=sys.stderr)
        return EXIT_ERROR


if __name__ == "__main__":
    sys.exit(main())
