"""A release's schema, for focus-ci's rollback floor (#165).

focus-ci (infra/server/focus-ci.sh) feeds this file, from its root-owned copy in
/opt/focus/infra, to a one-shot app container of the release it deploys, before the
migrations run:

    compose.sh <env> run --rm -T --pull never --no-deps app python - < app/migration_info.py

It reads that image's own migrations (alembic.ini in the working directory, /app), never
the database, and prints two lines:

    schema=<the alembic head the release migrates to>
    contracts=<its contract revisions on the way there, oldest first, comma-separated; - for none>

A contract revision is a migration file with a real comment line
`# contract-migration: <reason>` (a non-empty reason, not in a string): the marker
backend/tests/unit/test_migration_safety.py lets a destructive migration through with.
scripts/tests/test_migration_info.py checks both use the same rule.

It runs with every release's image, older ones included, so it needs only alembic and the
standard library. Exit status 1, with the reason on stderr, when the answer isn't
certain: more or less than one head, or a revision id focus-ci couldn't log as one word.
"""

import io
import re
import sys
import tokenize
from pathlib import Path

from alembic.config import Config
from alembic.script import ScriptDirectory

MARKER = re.compile(r"^#\s*contract-migration:\s*\S+")
# What focus-ci accepts in releases.log (REVISION_RE there): one word, no separator.
REVISION = re.compile(r"^[A-Za-z0-9_]{1,64}$")


def has_marker(source: str) -> bool:
    """True if a real comment (not a string or docstring) carries the marker and a reason."""
    return any(
        tok.type == tokenize.COMMENT and MARKER.match(tok.string)
        for tok in tokenize.generate_tokens(io.StringIO(source).readline)
    )


def schema_info(script: ScriptDirectory) -> tuple[str, list[str]]:
    """The single head, and the contract revisions from base to it, oldest first."""
    heads = script.get_heads()
    if len(heads) != 1:
        raise ValueError(f"expected exactly one alembic head, found {len(heads)}: {heads}")
    head = heads[0]
    contracts: list[str] = []
    # walk_revisions goes from the head down to base; reversed, oldest first.
    for revision in reversed(list(script.walk_revisions("base", head))):
        if not REVISION.match(revision.revision):
            raise ValueError(f"revision id {revision.revision!r} isn't 1-64 letters, digits or _")
        if revision.path and has_marker(Path(revision.path).read_text(encoding="utf-8")):
            contracts.append(revision.revision)
    return head, contracts


def render(head: str, contracts: list[str]) -> str:
    return f"schema={head}\ncontracts={','.join(contracts) or '-'}\n"


def main(config_file: str = "alembic.ini") -> int:
    try:
        head, contracts = schema_info(ScriptDirectory.from_config(Config(config_file)))
    except Exception as error:  # any doubt is a failure, which focus-ci reports
        print(f"migration_info: {error}", file=sys.stderr)
        return 1
    sys.stdout.write(render(head, contracts))
    return 0


if __name__ == "__main__":
    sys.exit(main())
