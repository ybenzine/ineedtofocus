"""infra/app/migration_info.py (#165): the schema focus-ci records for each deploy, and the
contract revisions that set an environment's rollback floor.

Each case runs the file the way focus-ci does, as `python -` with the file on stdin, in a
directory holding alembic.ini (the image's /app). `make test-server` covers what focus-ci
does with the answer; `make test-prod-stack` runs it in the real image.
"""

from __future__ import annotations

import importlib.util
import subprocess
import sys
from pathlib import Path
from types import ModuleType

import pytest
from alembic.config import Config
from alembic.script import ScriptDirectory

REPO = Path(__file__).resolve().parents[2]
HELPER = REPO / "infra" / "app" / "migration_info.py"
BACKEND = REPO / "backend"
SAFETY_TEST = BACKEND / "tests" / "unit" / "test_migration_safety.py"


def load(path: Path, name: str) -> ModuleType:
    spec = importlib.util.spec_from_file_location(name, path)
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


helper = load(HELPER, "migration_info")
safety = load(SAFETY_TEST, "migration_safety")


def run_helper(cwd: Path) -> subprocess.CompletedProcess[str]:
    """As focus-ci runs it: `python -`, the file on stdin, in the alembic.ini directory."""
    with HELPER.open() as stdin:
        return subprocess.run(
            [sys.executable, "-"],
            stdin=stdin,
            cwd=cwd,
            capture_output=True,
            text=True,
            check=False,
        )


def revision_file(revision: str, down: str | None, body: str = "") -> str:
    return (
        f'"""Revision {revision}."""\n\n'
        f"revision = {revision!r}\n"
        f"down_revision = {down!r}\n"
        "branch_labels = None\n"
        "depends_on = None\n\n\n"
        "def upgrade() -> None:\n"
        f"{body or '    pass'}\n"
    )


def project(tmp_path: Path, revisions: dict[str, str]) -> Path:
    """An alembic project in tmp_path: alembic.ini and migrations/versions/<file>."""
    versions = tmp_path / "migrations" / "versions"
    versions.mkdir(parents=True)
    for name, source in revisions.items():
        (versions / name).write_text(source)
    (tmp_path / "alembic.ini").write_text("[alembic]\nscript_location = migrations\n")
    return tmp_path


def test_the_repo_migrations_as_the_image_has_them() -> None:
    result = run_helper(BACKEND)
    assert result.returncode == 0, result.stderr
    config = Config(str(BACKEND / "alembic.ini"))
    config.set_main_option("script_location", str(BACKEND / "migrations"))
    script = ScriptDirectory.from_config(config)
    head = script.get_current_head()
    assert head is not None
    contracts = [
        revision.revision
        for revision in reversed(list(script.walk_revisions("base", head)))
        if safety.has_marker(Path(revision.path).read_text())
    ]
    lines = result.stdout.splitlines()
    assert lines[0] == f"schema={head}"
    assert lines[1] == f"contracts={','.join(contracts) or '-'}"
    assert len(lines) == 2


def test_contract_revisions_oldest_first(tmp_path: Path) -> None:
    drop = "    # contract-migration: column unused since 0001\n    op.drop_column('t', 'c')"
    in_docstring = '    """# contract-migration: only in a docstring"""'
    in_string = "    x = '# contract-migration: only in a string'"
    no_reason = "    # contract-migration:\n    pass"
    cwd = project(
        tmp_path,
        {
            "0001_base.py": revision_file("0001", None),
            "0002_drop.py": revision_file("0002", "0001", drop),
            "0003_doc.py": revision_file("0003", "0002", in_docstring),
            "0004_str.py": revision_file("0004", "0003", in_string),
            "0005_bare.py": revision_file("0005", "0004", no_reason),
            "0006_drop.py": revision_file("0006", "0005", drop),
        },
    )
    result = run_helper(cwd)
    assert result.returncode == 0, result.stderr
    assert result.stdout == "schema=0006\ncontracts=0002,0006\n"


def test_no_contract_revision(tmp_path: Path) -> None:
    cwd = project(
        tmp_path,
        {"a.py": revision_file("a1", None), "b.py": revision_file("b2", "a1")},
    )
    result = run_helper(cwd)
    assert (result.returncode, result.stdout) == (0, "schema=b2\ncontracts=-\n")


def test_two_heads_fail(tmp_path: Path) -> None:
    cwd = project(
        tmp_path,
        {
            "a.py": revision_file("a1", None),
            "b.py": revision_file("b2", "a1"),
            "c.py": revision_file("c3", "a1"),
        },
    )
    result = run_helper(cwd)
    assert result.returncode == 1
    assert result.stdout == ""
    assert "expected exactly one alembic head, found 2" in result.stderr


@pytest.mark.parametrize("bad", ["a-1", "a 1", "a,1", "x" * 65])
def test_a_revision_id_focus_ci_cannot_log_fails(tmp_path: Path, bad: str) -> None:
    cwd = project(
        tmp_path,
        {"a.py": revision_file("a1", None), "b.py": revision_file(bad, "a1")},
    )
    result = run_helper(cwd)
    assert result.returncode == 1
    assert result.stdout == ""
    assert result.stderr.startswith("migration_info: ")


def test_no_alembic_ini_fails(tmp_path: Path) -> None:
    result = run_helper(tmp_path)
    assert result.returncode == 1
    assert result.stdout == ""
    assert result.stderr.startswith("migration_info: ")


@pytest.mark.parametrize(
    "source",
    [
        "x = 1\n# contract-migration: column unused since v1.4\n",
        "#contract-migration: no space\n",
        "# contract-migration:\n",
        "# contract-migration:   \n",
        '"""# contract-migration: in a docstring"""\n',
        'x = "# contract-migration: in a string"\n',
        "x = 1  # contract-migration: trailing comment\n",
        "# not a contract-migration: elsewhere\n",
    ],
)
def test_same_marker_rule_as_the_migration_safety_test(source: str) -> None:
    assert helper.MARKER.pattern == safety.MARKER.pattern
    assert helper.has_marker(source) == safety.has_marker(source)
