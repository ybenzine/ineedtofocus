"""No shell test harness pipes into a reader that stops early (#256).

The harnesses run under `set -euo pipefail`. In `x=$(writer | head -n1)`, head exits after
one line; a writer with more left to write then dies of SIGPIPE, the pipeline's status is
141, and set -e stops the harness with it, after a passing check. Whether it happens
depends on the writer's write sizes and on scheduling, so it flakes: `make test-server`
failed with Error 141 that way, from `new_calls | head -n1` (tail writes a file 8 KiB at a
time). The harnesses use `first_line` (infra/server/tests/lib.sh), which reads its input
to the end, or read the file itself.

This checks every shell script of the harnesses (the host side and what runs in the test
container) for a pipe into head, `grep -q`/`--quiet` or `grep -m`/`--max-count`."""

from __future__ import annotations

import re
from pathlib import Path

import pytest

REPO = Path(__file__).resolve().parents[2]
HARNESS_DIRS = [REPO / "infra" / "tests", REPO / "infra" / "server" / "tests"]
SCRIPTS = sorted(p for d in HARNESS_DIRS for p in d.glob("*.sh"))

# A pipe (not ||) followed by an early-exit reader.
EARLY_EXIT_READER = re.compile(
    r"(?<!\|)\|(?!\|)\s*"
    r"(?:head\b"
    r"|grep\b(?:\s+-[^\s|;]*)*\s+(?:-[a-zA-Z]*[qm][a-zA-Z0-9]*|--quiet|--silent|--max-count)\b)"
)


def early_exit_pipes(text: str) -> list[str]:
    found = []
    for number, line in enumerate(text.splitlines(), 1):
        if line.lstrip().startswith("#"):
            continue
        if EARLY_EXIT_READER.search(line):
            found.append(f"{number}: {line.strip()}")
    return found


def test_finds_the_harness_scripts() -> None:
    names = {p.name for p in SCRIPTS}
    assert {"focus_ci.sh", "lib.sh", "run.sh", "check_config.sh", "prod_stack.sh"} <= names


@pytest.mark.parametrize(
    "line",
    [
        "first=$(new_calls | head -n1 | cut -d' ' -f1)",  # the #256 line
        'line_of() { grep -nF -- "$2" <<<"$1" | head -n1 | cut -d: -f1 || echo 0; }',
        "x=$(docker logs app|head -c 300)",
        "docker compose ps | grep -q healthy",
        "out | grep -F -m1 ready",
        "out | grep -Fqx ready",
        "out | grep --quiet ready",
        "out | grep -i --max-count=1 ready",
    ],
)
def test_catches_early_exit_readers(line: str) -> None:
    assert early_exit_pipes(line), line


@pytest.mark.parametrize(
    "line",
    [
        "first=$(new_calls | first_line | cut -d' ' -f1)",
        'grep -qF -- "$2" <<<"$1" && return 0',  # a here-string: no writer to kill
        'head -c 300 "$work/body"',  # reads a file, not a pipe
        "sshd -T -C user=deploy | grep -i '^port ' || true",
        "a || head -n1 file",
        "# never `| head -n1`: see #256",
    ],
)
def test_allows_full_readers(line: str) -> None:
    assert not early_exit_pipes(line), line


@pytest.mark.parametrize("script", SCRIPTS, ids=lambda p: str(p.relative_to(REPO)))
def test_no_early_exit_reader_in_a_pipe(script: Path) -> None:
    found = early_exit_pipes(script.read_text())
    assert not found, (
        f"{script.relative_to(REPO)} pipes into a reader that stops early; under pipefail "
        "the writer's SIGPIPE can fail the harness with status 141 (#256). Use first_line "
        "(infra/server/tests/lib.sh) or read the file directly:\n" + "\n".join(found)
    )
