"""Guard for the expand/contract rule (AGENTS.md: backward-compatible migrations only).

An app rollback must never need a database downgrade, so a migration may only *add*
things in `upgrade()`. Destructive operations are rejected unless the migration file
carries a `# contract-migration: <reason>` comment, which makes the exception visible
in review (use it only once no deployed app version still reads the removed thing).
"""

import ast
from pathlib import Path

import pytest

VERSIONS = Path(__file__).resolve().parents[2] / "migrations" / "versions"
DESTRUCTIVE = {
    "drop_table",
    "drop_column",
    "drop_constraint",
    "drop_index",
    "rename_table",
    "alter_column",
    "execute",
}
MARKER = "# contract-migration:"


def destructive_calls(source: str) -> list[str]:
    """Names of destructive `op.*` calls inside `upgrade()`."""
    found: list[str] = []
    for node in ast.parse(source).body:
        if isinstance(node, ast.FunctionDef) and node.name == "upgrade":
            for call in ast.walk(node):
                if (
                    isinstance(call, ast.Call)
                    and isinstance(call.func, ast.Attribute)
                    and call.func.attr in DESTRUCTIVE
                ):
                    found.append(call.func.attr)
    return found


def test_checker_flags_destructive_operations() -> None:
    src = (
        "def upgrade():\n    op.drop_column('t', 'c')\n\ndef downgrade():\n    op.drop_table('t')\n"
    )
    assert destructive_calls(src) == ["drop_column"]


def test_checker_ignores_downgrade_and_additive_ops() -> None:
    src = "def upgrade():\n    op.add_column('t', c)\n    op.create_index('i', 't', ['c'])\n"
    assert destructive_calls(src) == []


@pytest.mark.parametrize("path", sorted(VERSIONS.glob("*.py")), ids=lambda p: p.name)
def test_migrations_are_backward_compatible(path: Path) -> None:
    source = path.read_text()
    bad = destructive_calls(source)
    assert not bad or MARKER in source, (
        f"{path.name} runs {bad} in upgrade(). Expand first, contract in a later release; "
        f"if this is the contract step, add '{MARKER} <reason>'."
    )
