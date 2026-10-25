"""The shell test harnesses `make test` and `make test-prod-stack` run on the host can't pass
after a shell error (#183). macOS's /bin/bash 3.2 runs an EXIT trap with $? = 0 after a
syntax error or a bad substitution, so a harness with one used to exit 0 halfway through;
infra/tests/exit_guard.sh turns that into a failure.

Each harness is copied with one deliberate shell error inserted where it matters (right
after its EXIT trap is set, or after `set -euo pipefail` when it has none) and run under
every bash found here: `bash` on PATH and /bin/bash, which is 3.2 on a Mac and bash 5 in
CI. `docker` is a stub on PATH, so nothing real starts."""

from __future__ import annotations

import os
import re
import shutil
import subprocess
from pathlib import Path

import pytest

REPO = Path(__file__).resolve().parents[2]
INFRA = REPO / "infra"
GUARD = INFRA / "tests" / "exit_guard.sh"

# Every harness that runs on the host, with the line the error goes after. The container
# side of `make test-server` (in_container.sh, focus_ci.sh, fake_docker.sh, lib.sh) runs
# in Ubuntu's bash 5, never under the host's bash.
HOST_HARNESSES = {
    "tests/check_config.sh": "trap cleanup EXIT",
    "tests/prod_stack.sh": "trap cleanup EXIT",
    "server/tests/run.sh": "set -euo pipefail",
}

# Shell errors, not failing commands: errexit doesn't see them. Each is an error in bash
# 3.2 and in bash 5.
SHELL_ERRORS = {
    "syntax-error": "if [[ a -zz b ]]; then :; fi",
    "bad-substitution": ': "${PATH/}${PATH!}"',
    "unbound-variable": ': "$no_such_variable_183"',
}
UNREACHED = "UNREACHED-183"

STUB_DOCKER = """#!/bin/sh
# Stands in for docker: records the call, succeeds, prints nothing.
echo "$*" >> "$STUB_LOG"
"""


def bash_version(bash: str) -> str:
    return subprocess.run(
        [bash, "-c", "echo $BASH_VERSION"], capture_output=True, text=True, check=True
    ).stdout.strip()


def bashes() -> list[tuple[str, str]]:
    """(path, version) of each distinct bash: the one on PATH and /bin/bash."""
    found: dict[str, tuple[str, str]] = {}
    for candidate in (shutil.which("bash"), "/bin/bash"):
        if candidate and os.access(candidate, os.X_OK):
            found.setdefault(os.path.realpath(candidate), (candidate, bash_version(candidate)))
    return list(found.values())


BASHES = bashes()


def major(version: str) -> int:
    return int(version.split(".", 1)[0])


def copy_with_error(tmp_path: Path, harness: str, error: str) -> Path:
    """Copy the harness (and the guard) under tmp_path/infra, with `error` inserted."""
    lines = (INFRA / harness).read_text().splitlines(keepends=True)
    anchor = HOST_HARNESSES[harness]
    at = next(i for i, line in enumerate(lines) if line.strip() == anchor)
    lines[at + 1 : at + 1] = [f"{error}\n", f"echo {UNREACHED}\n"]
    copy = tmp_path / "infra" / harness
    copy.parent.mkdir(parents=True, exist_ok=True)
    copy.write_text("".join(lines))
    guard = tmp_path / "infra" / "tests" / GUARD.name
    guard.parent.mkdir(parents=True, exist_ok=True)
    shutil.copy(GUARD, guard)
    return copy


def run_harness(bash: str, script: Path, tmp_path: Path) -> subprocess.CompletedProcess[str]:
    bin_dir = tmp_path / "bin"
    bin_dir.mkdir(exist_ok=True)
    docker = bin_dir / "docker"
    docker.write_text(STUB_DOCKER)
    docker.chmod(0o755)
    skip = ("SMOKE_", "FOCUS_", "COMPOSE_")
    env = {k: v for k, v in os.environ.items() if not k.startswith(skip)}
    env.update(
        PATH=f"{bin_dir}{os.pathsep}{env['PATH']}",
        STUB_LOG=str(tmp_path / "docker.log"),
        # prod_stack.sh: skip the image build; test project names if anything got through.
        APP_TAG="exit-guard-test",
        FOCUS_TEST_PREFIX="focus-exit-guard-test",
    )
    return subprocess.run(
        [bash, str(script)], env=env, capture_output=True, text=True, timeout=60, check=False
    )


@pytest.mark.parametrize("error", SHELL_ERRORS.values(), ids=SHELL_ERRORS.keys())
@pytest.mark.parametrize("harness", HOST_HARNESSES)
@pytest.mark.parametrize(("bash", "version"), BASHES, ids=[f"bash-{v}" for _, v in BASHES])
def test_a_shell_error_fails_the_harness(
    tmp_path: Path, bash: str, version: str, harness: str, error: str
) -> None:
    result = run_harness(bash, copy_with_error(tmp_path, harness, error), tmp_path)
    output = result.stdout + result.stderr

    assert UNREACHED not in result.stdout, output  # the error did stop the script
    assert result.returncode != 0, output
    if major(version) < 4 and HOST_HARNESSES[harness].startswith("trap"):
        # The case #183 is about: bash 3.2 hands the trap 0; the guard catches it.
        assert "stopped before its last line" in result.stderr, output


def test_runs_under_macos_bash_3_2_when_present() -> None:
    """On a Mac the suite above must really cover bash 3.2, the bash that hid the error."""
    if not Path("/bin/bash").exists() or major(bash_version("/bin/bash")) >= 4:
        pytest.skip("/bin/bash isn't bash 3.2 here (bash 3.2 is macOS's)")
    assert any(major(version) < 4 for _, version in BASHES)


GUARDED = """#!/usr/bin/env bash
set -euo pipefail
. "$1"
cleanup() {
  local status=$?
  exit_guard "$status" || status=$?
  exit "$status"
}
trap cleanup EXIT
"""


@pytest.mark.parametrize(("bash", "version"), BASHES, ids=[f"bash-{v}" for _, v in BASHES])
@pytest.mark.parametrize(
    ("body", "status"),
    [
        ("echo passed\nharness_done\n", 0),  # reached the end: passes
        ("exit 3\n", 3),  # a failure keeps its status
        ("false\nharness_done\n", 1),  # errexit still applies
        ("exit 0\n", 1),  # stopping early with success is a failure without harness_done
        ("harness_done\nexit 0\n", 0),  # unless the harness says it's done
    ],
    ids=["completes", "fails", "errexit", "early-exit", "done-early"],
)
def test_exit_guard(tmp_path: Path, bash: str, version: str, body: str, status: int) -> None:
    script = tmp_path / "harness.sh"
    script.write_text(GUARDED + body)

    result = subprocess.run(
        [bash, str(script), str(GUARD)], capture_output=True, text=True, timeout=30, check=False
    )

    assert result.returncode == status, result.stdout + result.stderr


def test_every_host_harness_with_an_exit_trap_uses_the_guard() -> None:
    """A new harness in infra/tests is listed above, and any harness with an EXIT trap
    sources the guard and ends with harness_done."""
    in_infra_tests = {
        f"tests/{path.name}" for path in (INFRA / "tests").glob("*.sh") if path != GUARD
    }
    assert in_infra_tests <= HOST_HARNESSES.keys()
    for harness in HOST_HARNESSES:
        text = (INFRA / harness).read_text()
        if not re.search(r"^\s*trap .*\bEXIT\b", text, re.MULTILINE):
            continue
        assert '. "$here/exit_guard.sh"' in text, harness
        assert 'exit_guard "$status"' in text, harness
        assert text.rstrip().splitlines()[-1] == "harness_done", harness
