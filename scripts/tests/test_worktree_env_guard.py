"""scripts/require-worktree-env.sh and the Makefile targets it guards (#188): in a subagent
worktree (a path with /.claude/worktrees/ in it) that has no .env, `make up` and the other
stack targets stop before Compose runs, because Compose there would drive the main checkout's
stack. With a .env, or anywhere else (the main checkout, a session worktree, CI), they behave
as before.

Each test runs the real Makefile and scripts from a copy of the repo layout under tmp_path,
with fakes for `docker`, `curl` and `python3` on PATH that log their arguments and start
nothing. No test reads or writes the repo's own .env."""

from __future__ import annotations

import os
import shutil
import subprocess
from pathlib import Path

import pytest
import yaml  # type: ignore[import-untyped]  # no stubs in the locked env

REPO = Path(__file__).resolve().parents[2]
GUARD = "require-worktree-env.sh"
COPIED = ["Makefile", "scripts/require-worktree-env.sh", "scripts/stack-urls.sh"]

# Logs each call to $FAKE_LOG as "<name> <args>". `docker compose port` reports nothing running.
FAKE = """#!/usr/bin/env bash
echo "$(basename "$0") $*" >> "$FAKE_LOG"
case "$(basename "$0") $1 $2" in
  "docker compose port") exit 1 ;;
  "docker compose config") echo "name: focus-local" ;;
  curl*) exit 7 ;;
esac
exit 0
"""

# Where GitHub Actions checks the repo out (actions/checkout without `path:`).
CI_PATH = "home/runner/work/ineedtofocus/ineedtofocus"
SUBAGENT_PATH = "ineedtofocus/.claude/worktrees/agent-a3556db4"
STACK_TARGETS = ["up", "down", "logs", "check-stack", "test-e2e"]


def make_checkout(tmp_path: Path, relative: str, *, env_file: bool) -> Path:
    root = tmp_path / relative
    for name in COPIED:
        (root / name).parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(REPO / name, root / name)
    # test-e2e's prerequisite, up to date so make doesn't run `npm ci`.
    frontend = root / "frontend"
    frontend.mkdir()
    for name in ("package.json", "package-lock.json"):
        (frontend / name).write_text("{}\n")
    (frontend / "node_modules").mkdir()
    os.utime(frontend / "node_modules", (2_000_000_000, 2_000_000_000))
    if env_file:
        (root / ".env").write_text("COMPOSE_PROJECT_NAME=focus-m3\nAPP_PORT=8010\n")
    return root


def run_make(root: Path, target: str, **env: str) -> tuple[subprocess.CompletedProcess[str], str]:
    bin_dir = root.parent / f"{root.name}-bin"
    bin_dir.mkdir(exist_ok=True)
    for name in ("docker", "curl", "python3"):
        fake = bin_dir / name
        fake.write_text(FAKE)
        fake.chmod(0o755)
    log = root.parent / f"{root.name}-calls.log"
    log.write_text("")
    drop = ("CI", "PLAYWRIGHT_BASE_URL", "APP_PORT", "MAKEFLAGS", "MAKELEVEL", "MFLAGS")
    base = {k: v for k, v in os.environ.items() if k not in drop}
    base["PATH"] = f"{bin_dir}{os.pathsep}{base['PATH']}"
    result = subprocess.run(
        ["make", "--no-print-directory", target],
        env={**base, "FAKE_LOG": str(log), **env},
        capture_output=True,
        text=True,
        check=False,
        cwd=root,
    )
    return result, log.read_text()


def assert_stopped_by_guard(result: subprocess.CompletedProcess[str], target: str) -> None:
    assert f"make {target} stopped: this checkout is a subagent worktree with no .env" in (
        result.stderr
    )
    assert "cp <session folder>/.env .env" in result.stderr
    assert "_docs/process.md → Parallel sessions → Subagent worktrees" in result.stderr


@pytest.mark.parametrize("target", STACK_TARGETS)
def test_subagent_worktree_without_env_stops_before_anything_runs(
    tmp_path: Path, target: str
) -> None:
    root = make_checkout(tmp_path, SUBAGENT_PATH, env_file=False)
    result, calls = run_make(root, target)
    assert result.returncode != 0
    assert_stopped_by_guard(result, target)
    assert calls == ""  # no docker, curl or python3: nothing started, stopped or checked


def test_make_up_runs_in_a_subagent_worktree_with_env(tmp_path: Path) -> None:
    root = make_checkout(tmp_path, SUBAGENT_PATH, env_file=True)
    result, calls = run_make(root, "up")
    assert result.returncode == 0, result.stderr
    assert "stopped" not in result.stderr
    assert calls.splitlines()[0] == "docker compose up -d --build --wait"


@pytest.mark.parametrize(
    ("relative", "env"),
    [
        ("ineedtofocus", {}),  # the main checkout
        ("ineedtofocus-m3", {}),  # a session worktree
        (CI_PATH, {"CI": "true", "GITHUB_ACTIONS": "true"}),
    ],
)
def test_make_up_without_env_outside_claude_worktrees_runs_as_today(
    tmp_path: Path, relative: str, env: dict[str, str]
) -> None:
    root = make_checkout(tmp_path, relative, env_file=False)
    result, calls = run_make(root, "up", **env)
    assert result.returncode == 0, result.stderr
    assert "stopped" not in result.stderr
    assert calls.splitlines()[0] == "docker compose up -d --build --wait"


@pytest.mark.parametrize("target", ["check-stack", "down"])
def test_the_guard_never_fires_in_ci(tmp_path: Path, target: str) -> None:
    """CI's e2e job runs `make up`, `make check-stack` and `make test-e2e` with no .env."""
    root = make_checkout(tmp_path, CI_PATH, env_file=False)
    result, calls = run_make(root, target, CI="true")
    assert result.returncode == 0, result.stderr
    assert calls.splitlines()[0] in ("python3 scripts/check_local_stack.py", "docker compose down")


def test_make_test_skips_e2e_in_a_subagent_worktree_without_env(tmp_path: Path) -> None:
    """Rather than test the main checkout's stack as if it were this worktree's."""
    root = make_checkout(tmp_path, SUBAGENT_PATH, env_file=False)
    result, calls = run_make(root, "test-e2e-if-up")
    assert result.returncode == 0, result.stderr
    assert_stopped_by_guard(result, "test's e2e step")
    assert "SKIPPED e2e: no stack of this worktree's own" in result.stderr
    assert calls == ""


def test_make_test_fails_e2e_there_when_ci_is_set(tmp_path: Path) -> None:
    root = make_checkout(tmp_path, SUBAGENT_PATH, env_file=False)
    result, _ = run_make(root, "test-e2e-if-up", CI="true")
    assert result.returncode != 0
    assert "FAILED e2e: no stack of this worktree's own" in result.stderr


@pytest.mark.parametrize("target", ["test-e2e", "test-e2e-if-up"])
def test_an_explicit_playwright_base_url_skips_the_guard(tmp_path: Path, target: str) -> None:
    root = make_checkout(tmp_path, SUBAGENT_PATH, env_file=False)
    result, calls = run_make(root, target, PLAYWRIGHT_BASE_URL="http://localhost:8010")
    assert "subagent worktree" not in result.stderr
    if target == "test-e2e-if-up":  # the fake curl finds no stack there
        assert "SKIPPED e2e: no stack at http://localhost:8010" in result.stderr
        assert calls.startswith("curl ")
    else:  # past the guard, on to the next check (no Playwright config in the copy)
        assert "frontend/playwright.config.* is missing." in result.stderr


def test_make_test_runs_e2e_as_before_in_a_subagent_worktree_with_env(tmp_path: Path) -> None:
    root = make_checkout(tmp_path, SUBAGENT_PATH, env_file=True)
    result, calls = run_make(root, "test-e2e-if-up")
    assert result.returncode == 0, result.stderr
    assert "SKIPPED e2e: no stack at http://localhost:8010" in result.stderr
    assert "curl -fsS --max-time 3 http://localhost:8010/healthz" in calls


def test_the_guard_script_alone(tmp_path: Path) -> None:
    for relative, env_file, code in [
        (SUBAGENT_PATH, False, 1),
        (SUBAGENT_PATH + "-2", True, 0),
        (CI_PATH, False, 0),
    ]:
        root = make_checkout(tmp_path, relative, env_file=env_file)
        result = subprocess.run(
            [str(root / "scripts" / GUARD), "make up"],
            capture_output=True,
            text=True,
            check=False,
            cwd=tmp_path,  # the script finds the checkout from its own path
        )
        assert result.returncode == code, (relative, result.stderr)
        assert (result.stderr != "") == (code != 0)


def test_ci_checks_out_outside_claude_worktrees() -> None:
    """The CI cases above assume actions/checkout's default path: no job sets `path:`."""
    workflows = REPO / ".github" / "workflows"
    for workflow in [*workflows.glob("*.yml"), *workflows.glob("*.yaml")]:
        jobs = yaml.safe_load(workflow.read_text())["jobs"]
        for job in jobs.values():
            for step in job.get("steps", []):
                if str(step.get("uses", "")).startswith("actions/checkout@"):
                    assert "path" not in (step.get("with") or {}), workflow.name
