"""Lint test for the expand/contract rule (AGENTS.md: backward-compatible migrations only).

An app rollback must never need a database downgrade, so a migration should only *add*
things in `upgrade()`. This test catches the common violations by reading each migration's
AST: destructive `op.*` calls (including via an alias or `from alembic.op import ...`),
raw SQL, and `add_column` of a NOT NULL column without a `server_default`. It is a safety
net, not a proof; code review still decides. A deliberate contract step needs a real
comment line `# contract-migration: <reason>` with a non-empty reason.
"""

import ast
import io
import re
import tokenize
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
    "exec_driver_sql",
}
MARKER = re.compile(r"^#\s*contract-migration:\s*\S+")


def has_marker(source: str) -> bool:
    """True if a real comment (not a string or docstring) carries the marker and a reason."""
    return any(
        tok.type == tokenize.COMMENT and MARKER.match(tok.string)
        for tok in tokenize.generate_tokens(io.StringIO(source).readline)
    )


def _is_not_null_without_default(call: ast.Call) -> bool:
    for arg in [*call.args, *(k.value for k in call.keywords)]:
        if (
            isinstance(arg, ast.Call)
            and (getattr(arg.func, "attr", None) or getattr(arg.func, "id", None)) == "Column"
        ):
            kw = {k.arg: k.value for k in arg.keywords}
            nullable = kw.get("nullable")
            if (
                isinstance(nullable, ast.Constant)
                and nullable.value is False
                and "server_default" not in kw
            ):
                return True
    return False


def destructive_calls(source: str) -> list[str]:
    """Violations inside `upgrade()`: destructive op names, or 'add_column_not_null'."""
    tree = ast.parse(source)
    op_names = {"op"}  # names bound to alembic.op
    direct: dict[str, str] = {}  # local name -> destructive function imported from alembic.op
    for node in ast.walk(tree):
        if isinstance(node, ast.ImportFrom) and node.module == "alembic":
            op_names |= {a.asname or a.name for a in node.names if a.name == "op"}
        elif isinstance(node, ast.ImportFrom) and node.module == "alembic.op":
            direct |= {a.asname or a.name: a.name for a in node.names if a.name in DESTRUCTIVE}
        elif isinstance(node, ast.Import):
            op_names |= {a.asname for a in node.names if a.name == "alembic.op" and a.asname}

    found: list[str] = []
    for node in tree.body:
        if not (isinstance(node, ast.FunctionDef) and node.name == "upgrade"):
            continue
        for call in ast.walk(node):
            if not isinstance(call, ast.Call):
                continue
            func = call.func
            if isinstance(func, ast.Attribute):
                if func.attr in DESTRUCTIVE:
                    found.append(func.attr)
                elif (
                    func.attr == "add_column"
                    and isinstance(func.value, ast.Name)
                    and func.value.id in op_names
                    and _is_not_null_without_default(call)
                ):
                    found.append("add_column_not_null")
            elif isinstance(func, ast.Name) and func.id in direct:
                found.append(direct[func.id])
    return found


def test_checker_flags_destructive_operations() -> None:
    src = (
        "def upgrade():\n    op.drop_column('t', 'c')\n\ndef downgrade():\n    op.drop_table('t')\n"
    )
    assert destructive_calls(src) == ["drop_column"]


def test_checker_ignores_downgrade_and_additive_ops() -> None:
    src = "def upgrade():\n    op.add_column('t', c)\n    op.create_index('i', 't', ['c'])\n"
    assert destructive_calls(src) == []


def test_checker_flags_raw_sql_variants() -> None:
    src = "def upgrade():\n    conn.exec_driver_sql('DROP TABLE t')\n    op.execute('x')\n"
    assert destructive_calls(src) == ["exec_driver_sql", "execute"]


def test_checker_flags_aliased_imports() -> None:
    src = "from alembic.op import drop_table as dt\ndef upgrade():\n    dt('t')\n"
    assert destructive_calls(src) == ["drop_table"]
    src = "from alembic import op as o\ndef upgrade():\n    o.drop_column('t', 'c')\n"
    assert destructive_calls(src) == ["drop_column"]


def test_checker_flags_not_null_column_without_default() -> None:
    bad = "def upgrade():\n    op.add_column('t', sa.Column('c', sa.Integer(), nullable=False))\n"
    assert destructive_calls(bad) == ["add_column_not_null"]
    ok_default = (
        "def upgrade():\n    op.add_column('t', sa.Column('c', sa.Integer(), "
        "nullable=False, server_default='0'))\n"
    )
    ok_nullable = "def upgrade():\n    op.add_column('t', sa.Column('c', sa.Integer()))\n"
    assert destructive_calls(ok_default) == []
    assert destructive_calls(ok_nullable) == []


def test_marker_must_be_a_comment_with_a_reason() -> None:
    assert has_marker("x = 1\n# contract-migration: column unused since v1.4\n")
    assert not has_marker("# contract-migration:\n")  # no reason
    assert not has_marker("# contract-migration:   \n")
    assert not has_marker('"""# contract-migration: in a docstring"""\n')
    assert not has_marker('x = "# contract-migration: in a string"\n')


@pytest.mark.parametrize("path", sorted(VERSIONS.glob("*.py")), ids=lambda p: p.name)
def test_migrations_are_backward_compatible(path: Path) -> None:
    source = path.read_text()
    bad = destructive_calls(source)
    assert not bad or has_marker(source), (
        f"{path.name} does {bad} in upgrade(). Expand first, contract in a later release; "
        "if this is the contract step, add a comment '# contract-migration: <reason>'."
    )
