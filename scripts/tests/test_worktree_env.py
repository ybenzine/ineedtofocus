"""scripts/worktree-env.sh and the Makefile targets around it (#442): each subagent worktree
gets its own Compose project and a slot of host ports, claimed so that two agents starting
at once never share one, and freed by `make down`.

Each test runs the real script and Makefile from copies under tmp_path laid out like
<main checkout>/.claude/worktrees/<id>, with slots kept in a tmp directory
(WORKTREE_SLOT_DIR), the port check replaced by a list of busy ports
(WORKTREE_SLOT_TEST_BUSY_PORTS) and a fake `docker` on PATH that logs its arguments and
starts nothing. No test reads or writes the repo's own .env or slots."""

from __future__ import annotations

import json
import os
import shutil
import subprocess
from pathlib import Path
from typing import Any

import pytest

REPO = Path(__file__).resolve().parents[2]
COPIED = [
    "Makefile",
    ".env.example",
    "compose.yaml",
    "compose.test.yaml",
    "scripts/worktree-env.sh",
    "scripts/require-worktree-env.sh",
    "scripts/stack-urls.sh",
]
SLOTS = range(10, 18)

# Logs each call to $FAKE_LOG; `docker compose ls` prints $FAKE_COMPOSE_LS.
FAKE_DOCKER = """#!/usr/bin/env bash
echo "docker $*" >> "$FAKE_LOG"
case "$1 $2" in
  "compose port") exit 1 ;;
  "compose config") echo "name: focus-test" ;;
  "compose ls") printf '%s\\n' "${FAKE_COMPOSE_LS:-[]}" ;;
esac
exit 0
"""

SESSION_ENV = """\
# the session's own settings
COMPOSE_PROJECT_NAME=focus-m6
POSTGRES_USER=focus
POSTGRES_PASSWORD=focus
POSTGRES_DB=focus
export APP_PORT=8010
GRAFANA_PORT=3010
OTLP_GRPC_PORT=4327
OTLP_HTTP_PORT=4328
POSTGRES_PORT=5442
DATABASE_URL=postgresql+asyncpg://focus:focus@localhost:5442/focus
LOG_LEVEL=DEBUG
"""


class Lab:
    """A main checkout with subagent worktrees under .claude/worktrees/, a session folder
    and a shared slot directory, all under tmp_path."""

    def __init__(self, tmp_path: Path) -> None:
        self.tmp = tmp_path
        self.main = tmp_path / "ineedtofocus"
        self.session = tmp_path / "ineedtofocus-m6"
        self.session.mkdir()
        (self.session / ".env").write_text(SESSION_ENV)
        self.slots = tmp_path / "slots"
        self.bin = tmp_path / "bin"
        self.bin.mkdir()
        (self.bin / "docker").write_text(FAKE_DOCKER)
        (self.bin / "docker").chmod(0o755)
        self.log = tmp_path / "docker.log"
        self.log.write_text("")

    def worktree(self, name: str) -> Path:
        root = self.main / ".claude" / "worktrees" / name
        copy_checkout(root)
        return root

    def env(self, **extra: str) -> dict[str, str]:
        drop = ("CI", "PLAYWRIGHT_BASE_URL", "APP_PORT", "COMPOSE_PROJECT_NAME", "MAKEFLAGS")
        base = {k: v for k, v in os.environ.items() if k not in drop and k not in ("MAKELEVEL",)}
        base["PATH"] = f"{self.bin}{os.pathsep}{base['PATH']}"
        return {
            **base,
            "WORKTREE_SLOT_DIR": str(self.slots),
            "WORKTREE_SLOT_TEST_BUSY_PORTS": "",
            "FAKE_LOG": str(self.log),
            **extra,
        }

    def script(self, root: Path, *args: str, **extra: str) -> subprocess.CompletedProcess[str]:
        return subprocess.run(
            [str(root / "scripts" / "worktree-env.sh"), *args],
            env=self.env(**extra),
            capture_output=True,
            text=True,
            check=False,
            cwd=self.tmp,  # the script finds its checkout from its own path
        )

    def make(self, root: Path, *args: str, **extra: str) -> subprocess.CompletedProcess[str]:
        return subprocess.run(
            ["make", "--no-print-directory", *args],
            env=self.env(**extra),
            capture_output=True,
            text=True,
            check=False,
            cwd=root,
        )

    def write(self, root: Path, **extra: str) -> dict[str, str]:
        result = self.script(root, "write", str(self.session), **extra)
        assert result.returncode == 0, result.stderr
        return read_env(root)

    def owners(self) -> dict[int, str]:
        if not self.slots.exists():
            return {}
        return {
            int(slot.name): (slot / "owner").read_text().strip()
            for slot in self.slots.iterdir()
            if slot.name.isdigit()
        }


def copy_checkout(root: Path) -> None:
    for name in COPIED:
        (root / name).parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(REPO / name, root / name)
    frontend = root / "frontend"
    frontend.mkdir()
    for name in ("package.json", "package-lock.json"):
        (frontend / name).write_text("{}\n")
    (frontend / "node_modules").mkdir()
    os.utime(frontend / "node_modules", (2_000_000_000, 2_000_000_000))


def read_env(root: Path) -> dict[str, str]:
    """The .env as Compose reads it (last value wins), plus a count of each key."""
    values: dict[str, str] = {}
    for line in (root / ".env").read_text().splitlines():
        line = line.strip()
        if not line or line.startswith("#"):
            continue
        key, _, value = line.removeprefix("export ").partition("=")
        assert key not in values, f"{key} is set twice"
        values[key] = value
    return values


@pytest.fixture
def lab(tmp_path: Path) -> Lab:
    return Lab(tmp_path)


# --- The generated .env --------------------------------------------------------------------


def test_writes_its_own_project_and_slot_ports(lab: Lab) -> None:
    root = lab.worktree("agent-a1b2c3")
    env = lab.write(root)
    assert env["COMPOSE_PROJECT_NAME"] == "focus-m6-agent-a1b2c3"
    assert env["WORKTREE_SLOT"] == "10"
    assert env["WORKTREE_SESSION"] == str(lab.session.resolve())
    assert env["APP_PORT"] == "8100"
    assert env["GRAFANA_PORT"] == "3100"
    assert env["OTLP_GRPC_PORT"] == "4417"
    assert env["OTLP_HTTP_PORT"] == "4418"
    assert env["POSTGRES_PORT"] == "5532"
    assert env["DATABASE_URL"] == "postgresql+asyncpg://focus:focus@localhost:5532/focus"
    # Everything else comes from the session's .env.
    assert env["LOG_LEVEL"] == "DEBUG"
    assert lab.owners() == {10: str(root.resolve())}
    assert (lab.slots / "10" / "project").read_text().strip() == "focus-m6-agent-a1b2c3"


def test_make_worktree_env_writes_it_too(lab: Lab) -> None:
    root = lab.worktree("agent-make")
    result = lab.make(root, "worktree-env", f"SESSION={lab.session}")
    assert result.returncode == 0, result.stderr
    assert "slot 10: app http://localhost:8100, Vite 5273" in result.stdout
    assert read_env(root)["APP_PORT"] == "8100"


def test_main_checkout_session_and_odd_names(lab: Lab) -> None:
    """The main checkout's session (focus-local) and a worktree name Compose wouldn't take."""
    (lab.session / ".env").write_text("COMPOSE_PROJECT_NAME=focus-local\nPOSTGRES_DB=app\n")
    root = lab.worktree("Agent.X_9")
    env = lab.write(root)
    assert env["COMPOSE_PROJECT_NAME"] == "focus-local-agent-x_9"
    assert env["DATABASE_URL"].endswith("@localhost:5532/app")


def test_falls_back_to_env_example_without_a_session_env(lab: Lab) -> None:
    (lab.session / ".env").unlink()
    root = lab.worktree("agent-noenv")
    env = lab.write(root)
    assert env["COMPOSE_PROJECT_NAME"] == "focus-local-agent-noenv"
    assert env["APP_PORT"] == "8100"
    assert env["SESSION_TTL_DAYS"] == "30"  # from .env.example


def test_rerunning_keeps_the_slot(lab: Lab) -> None:
    root = lab.worktree("agent-again")
    assert lab.write(root)["WORKTREE_SLOT"] == "10"
    lab.worktree("agent-other")
    assert lab.write(root)["WORKTREE_SLOT"] == "10"
    assert list(lab.owners()) == [10]


@pytest.mark.parametrize(
    "outside",
    ["ineedtofocus", "ineedtofocus-m3", "home/runner/work/ineedtofocus/ineedtofocus"],
)
def test_refuses_outside_a_subagent_worktree(lab: Lab, outside: str) -> None:
    root = lab.tmp / outside
    copy_checkout(root)
    result = lab.script(root, "write", str(lab.session))
    assert result.returncode != 0
    assert "is not a subagent worktree" in result.stderr
    assert not (root / ".env").exists()
    assert lab.owners() == {}


# --- Slot allocation -----------------------------------------------------------------------


def test_each_worktree_gets_the_next_free_slot(lab: Lab) -> None:
    ports = [lab.write(lab.worktree(f"agent-{n}"))["APP_PORT"] for n in range(3)]
    assert ports == ["8100", "8110", "8120"]


def test_eight_agents_starting_at_once_get_eight_different_slots(lab: Lab) -> None:
    roots = [lab.worktree(f"agent-{n}") for n in range(9)]
    procs = [
        subprocess.Popen(
            [str(root / "scripts" / "worktree-env.sh"), "write", str(lab.session)],
            env=lab.env(),
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
        )
        for root in roots
    ]
    results = [(proc.wait(), proc.communicate()[1]) for proc in procs]
    ok = [root for root, (code, _) in zip(roots, results, strict=True) if code == 0]
    failed = [err for code, err in results if code != 0]
    assert len(ok) == 8, failed
    assert len(failed) == 1 and "no free slot (10-17)" in failed[0]
    slots = sorted(int(read_env(root)["WORKTREE_SLOT"]) for root in ok)
    assert slots == list(SLOTS)
    assert sorted(lab.owners().values()) == sorted(str(root.resolve()) for root in ok)


def test_skips_a_slot_whose_ports_are_in_use(lab: Lab) -> None:
    root = lab.worktree("agent-busy")
    # Something else listens on slot 10's Vite port and slot 11's Postgres port.
    env = lab.write(root, WORKTREE_SLOT_TEST_BUSY_PORTS="5273 5542")
    assert env["WORKTREE_SLOT"] == "12"
    assert list(lab.owners()) == [12]


def test_takes_over_a_slot_whose_worktree_is_gone(lab: Lab) -> None:
    gone = lab.worktree("agent-gone")
    lab.write(gone)
    shutil.rmtree(gone)
    root = lab.worktree("agent-new")
    assert lab.write(root)["WORKTREE_SLOT"] == "10"
    assert lab.owners() == {10: str(root.resolve())}


def test_a_gone_worktrees_slot_with_a_running_stack_is_skipped(lab: Lab) -> None:
    gone = lab.worktree("agent-gone")
    lab.write(gone)
    shutil.rmtree(gone)
    root = lab.worktree("agent-new")
    assert lab.write(root, WORKTREE_SLOT_TEST_BUSY_PORTS="8100")["WORKTREE_SLOT"] == "11"


# --- Claim, release and the Makefile -------------------------------------------------------


def test_make_down_frees_the_slot_and_removes_the_stack(lab: Lab) -> None:
    root = lab.worktree("agent-down")
    lab.write(root)
    result = lab.make(root, "down")
    assert result.returncode == 0, result.stderr
    assert "Freed slot 10." in result.stdout
    assert lab.owners() == {}
    assert lab.log.read_text().splitlines() == ["docker compose down --rmi local"]
    # The next agent can have it.
    assert lab.write(lab.worktree("agent-next"))["WORKTREE_SLOT"] == "10"


def test_make_up_test_claims_the_slot_again_and_starts_the_lean_stack(lab: Lab) -> None:
    root = lab.worktree("agent-up")
    lab.write(root)
    lab.make(root, "down")
    lab.log.write_text("")
    result = lab.make(root, "up-test")
    assert result.returncode == 0, result.stderr
    assert lab.owners() == {10: str(root.resolve())}
    calls = lab.log.read_text().splitlines()
    assert calls[0] == "docker compose -f compose.yaml -f compose.test.yaml up -d --build --wait"


def test_claim_moves_to_a_free_slot_when_another_worktree_took_it(lab: Lab) -> None:
    root = lab.worktree("agent-first")
    lab.write(root)
    lab.make(root, "down")
    other = lab.worktree("agent-second")
    assert lab.write(other)["WORKTREE_SLOT"] == "10"
    result = lab.make(root, "up")
    assert result.returncode == 0, result.stderr
    assert "slot 10 is now" in result.stderr
    env = read_env(root)
    assert env["WORKTREE_SLOT"] == "11"
    assert env["APP_PORT"] == "8110"
    assert env["COMPOSE_PROJECT_NAME"] == "focus-m6-agent-first"
    assert lab.owners() == {10: str(other.resolve()), 11: str(root.resolve())}


@pytest.mark.parametrize("env_text", [None, "COMPOSE_PROJECT_NAME=focus-m6\nAPP_PORT=8010\n"])
@pytest.mark.parametrize("target", ["up", "down"])
def test_without_a_slot_up_and_down_run_as_before(
    lab: Lab, env_text: str | None, target: str
) -> None:
    """The main checkout, a session worktree or CI (no .env), or a .env copied by hand."""
    root = lab.tmp / "ineedtofocus-m6-copy"
    copy_checkout(root)
    if env_text is not None:
        (root / ".env").write_text(env_text)
    result = lab.make(root, target)
    assert result.returncode == 0, result.stderr
    first = lab.log.read_text().splitlines()[0]
    assert first == {"up": "docker compose up -d --build --wait", "down": "docker compose down"}[target]
    assert "slot" not in result.stdout + result.stderr
    assert not lab.slots.exists()


def test_make_up_test_needs_a_worktree_env_in_a_subagent_worktree(lab: Lab) -> None:
    root = lab.worktree("agent-noenv")
    result = lab.make(root, "up-test")
    assert result.returncode != 0
    assert "make worktree-env SESSION=<session folder>" in result.stderr
    assert lab.log.read_text() == ""


# --- Garbage collection --------------------------------------------------------------------


def test_gc_stops_stacks_of_gone_worktrees_only(lab: Lab) -> None:
    live = lab.worktree("agent-live")
    lab.write(live)
    gone = lab.worktree("agent-gone")
    lab.write(gone)
    shutil.rmtree(gone)
    worktrees = lab.main / ".claude" / "worktrees"
    compose_ls = [
        # The live worktree's and the main checkout's stacks stay.
        {"Name": "focus-m6-agent-live", "ConfigFiles": f"{live}/compose.yaml"},
        {"Name": "focus-local", "ConfigFiles": f"{lab.main}/compose.yaml"},
        # A session's shared stack that subagents started from their worktrees with a copied
        # .env (as before #442): its config files point into removed worktrees, but it's
        # the session's, so it stays.
        {
            "Name": "focus-local",
            "ConfigFiles": f"{worktrees}/agent-x/compose.yaml,{worktrees}/agent-y/compose.yaml",
        },
        {"Name": "focus-m6", "ConfigFiles": f"{worktrees}/agent-z/compose.yaml"},
        # Some other project in a gone worktree, not named by worktree-env.
        {"Name": "scratch", "ConfigFiles": f"{worktrees}/agent-w/compose.yaml"},
        # A gone worktree's stack with no slot record (e.g. a .env copied by hand).
        {
            "Name": "focus-m6-agent-old",
            "ConfigFiles": f"{worktrees}/agent-old/compose.yaml,{worktrees}/agent-old/compose.test.yaml",
        },
        # The gone worktree with a slot: stopped once, not twice.
        {"Name": "focus-m6-agent-gone", "ConfigFiles": f"{gone}/compose.yaml"},
    ]
    result = lab.make(live, "worktree-gc", FAKE_COMPOSE_LS=json.dumps(compose_ls))
    assert result.returncode == 0, result.stderr
    downs = [line for line in lab.log.read_text().splitlines() if " down " in line]
    assert len(downs) == 2
    assert "-p focus-m6-agent-gone down --rmi local --remove-orphans" in downs[0]
    assert "-p focus-m6-agent-old down --rmi local --remove-orphans" in downs[1]
    assert lab.owners() == {10: str(live.resolve())}
    assert "Freed slot 11" in result.stdout
    assert "focus-m6-agent-live" in result.stdout  # listed as still in use


# --- The lean stack (compose.test.yaml) ----------------------------------------------------


def lean_config(tmp_path: Path, *extra: str) -> dict[str, Any]:
    if shutil.which("docker") is None:
        pytest.skip("needs Docker Compose")
    for name in ("compose.yaml", "compose.test.yaml"):
        shutil.copy2(REPO / name, tmp_path / name)  # no .env next to them
    result = subprocess.run(
        ["docker", "compose", "-f", "compose.yaml", "-f", "compose.test.yaml", *extra, "config"]
        + ["--format", "json"],
        capture_output=True,
        text=True,
        check=True,
        cwd=tmp_path,
        env={k: v for k, v in os.environ.items() if not k.startswith("COMPOSE_")},
    )
    config: dict[str, Any] = json.loads(result.stdout)
    return config


def test_the_lean_stack_is_app_and_postgres_on_a_tmpfs(tmp_path: Path) -> None:
    config = lean_config(tmp_path)
    services = config["services"]
    assert sorted(services) == ["app", "db"]
    # Throwaway database: no volume for `make down` to leave behind or `down -v` to remove.
    assert "volumes" not in services["db"]
    assert services["db"]["tmpfs"] == ["/var/lib/postgresql/data"]
    assert not config.get("volumes")
    assert list(services["app"]["depends_on"]) == ["db"]
    env = services["app"]["environment"]
    for signal in ("TRACES", "METRICS", "LOGS"):
        assert env[f"OTEL_{signal}_EXPORTER"] == "none"
    assert env["SIGNUP_MAX_PER_CLIENT"] == "1000"
    # Every container still has a memory limit.
    assert all(service.get("mem_limit") for service in services.values())


def test_grafana_starts_only_when_asked(tmp_path: Path) -> None:
    config = lean_config(tmp_path, "--profile", "observability")
    assert "lgtm" in config["services"]
