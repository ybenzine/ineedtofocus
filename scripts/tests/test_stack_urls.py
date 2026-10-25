"""scripts/stack-urls.sh and the Makefile targets that use it (#83): `make up` prints the URLs
of the ports Compose actually published, and the e2e targets default to this checkout's own
app, so a second worktree with its own .env never tests another checkout's stack. `docker` is
a fake on PATH; the script runs from a copy of the repo layout so each test owns its `.env`."""

from __future__ import annotations

import os
import re
import shutil
import subprocess
from pathlib import Path

import pytest

REPO = Path(__file__).resolve().parents[2]
SCRIPT = REPO / "scripts" / "stack-urls.sh"
MAKEFILE = (REPO / "Makefile").read_text()

FAKE_DOCKER = """#!/usr/bin/env bash
# Stands in for `docker compose port <service> <port>` and `docker compose config`.
# FAKE_PORT_<service>_<port> is the published host port; unset means not running.
if [[ $1 == compose && $2 == port ]]; then
  var="FAKE_PORT_$3_$4"
  if [[ -z ${!var-} ]]; then echo "service \\"$3\\" is not running" >&2; exit 1; fi
  echo "127.0.0.1:${!var}"
elif [[ $1 == compose && $2 == config ]]; then
  printf 'name: %s\\nservices:\\n  app: {}\\n' "${FAKE_PROJECT:-focus-local}"
else
  exit 99
fi
"""


@pytest.fixture
def checkout(tmp_path: Path) -> Path:
    """A checkout with the script in scripts/ and a fake docker on PATH (in bin/)."""
    root = tmp_path / "checkout"
    (root / "scripts").mkdir(parents=True)
    shutil.copy2(SCRIPT, root / "scripts" / SCRIPT.name)
    bin_dir = tmp_path / "bin"
    bin_dir.mkdir()
    docker = bin_dir / "docker"
    docker.write_text(FAKE_DOCKER)
    docker.chmod(0o755)
    return root


def run(checkout: Path, *args: str, **env: str) -> subprocess.CompletedProcess[str]:
    base = {k: v for k, v in os.environ.items() if k != "APP_PORT" and not k.startswith("FAKE_")}
    base["PATH"] = f"{checkout.parent / 'bin'}{os.pathsep}{base['PATH']}"
    return subprocess.run(
        [str(checkout / "scripts" / SCRIPT.name), *args],
        env={**base, **env},
        capture_output=True,
        text=True,
        check=False,
        cwd=checkout.parent,  # the script finds the checkout from its own path
    )


def test_prints_the_project_and_the_published_ports(checkout: Path) -> None:
    result = run(
        checkout,
        FAKE_PROJECT="focus-m3",
        FAKE_PORT_app_8000="8010",
        FAKE_PORT_lgtm_3000="3010",
        FAKE_PORT_lgtm_4318="4328",
        FAKE_PORT_db_5432="5442",
    )
    assert result.returncode == 0, result.stderr
    assert result.stdout.splitlines() == [
        "Project:  focus-m3",
        "App:      http://localhost:8010",
        "Grafana:  http://localhost:3010",
        "OTLP:     http://localhost:4328",
        "Postgres: localhost:5442",
    ]


def test_says_which_services_are_not_running(checkout: Path) -> None:
    result = run(checkout, FAKE_PORT_db_5432="5432")
    assert result.returncode == 0, result.stderr
    assert "App:      not running" in result.stdout
    assert "Postgres: localhost:5432" in result.stdout


def test_app_url_is_the_published_port_while_the_stack_runs(checkout: Path) -> None:
    (checkout / ".env").write_text("APP_PORT=8000\n")
    result = run(checkout, "app", FAKE_PORT_app_8000="8010")
    assert result.stdout == "http://localhost:8010\n"


@pytest.mark.parametrize(
    ("env_file", "expected"),
    [
        (None, "8000"),
        ("APP_PORT=8010\n", "8010"),
        ("# APP_PORT=9999\nAPP_PORT = 8010  # second worktree\n", "8010"),
        ('APP_PORT="8020"\n', "8020"),
        ("POSTGRES_PORT=5442\n", "8000"),
        # Compose's .env parser also takes `export NAME=value` (#188).
        ("export APP_PORT=8010\n", "8010"),
        ("  export   APP_PORT = '8020'  # third worktree\n", "8020"),
        ("APP_PORT=8010\nexport APP_PORT=8020\n", "8020"),
        ("export APP_PORT=8010\nAPP_PORT=8020\n", "8020"),
        ("exportAPP_PORT=8010\nexport OTHER_APP_PORT=8030\n", "8000"),
    ],
)
def test_app_url_falls_back_to_the_configured_port(
    checkout: Path, env_file: str | None, expected: str
) -> None:
    if env_file is not None:
        (checkout / ".env").write_text(env_file)
    result = run(checkout, "app")
    assert result.returncode == 0, result.stderr
    assert result.stdout == f"http://localhost:{expected}\n"


def test_the_environment_wins_over_env_file(checkout: Path) -> None:
    """As in Compose: a variable set in the shell overrides .env."""
    (checkout / ".env").write_text("APP_PORT=8010\n")
    assert run(checkout, "app", APP_PORT="8030").stdout == "http://localhost:8030\n"


def test_unknown_argument_is_refused(checkout: Path) -> None:
    result = run(checkout, "grafana")
    assert result.returncode == 2
    assert "usage" in result.stderr


def recipe(target: str) -> str:
    match = re.search(rf"^{re.escape(target)}:.*\n((?:\t.*\n)+)", MAKEFILE, re.MULTILINE)
    assert match, target
    return match[1]


def test_make_up_prints_the_urls_in_use() -> None:
    assert "@scripts/stack-urls.sh\n" in recipe("up")
    assert "localhost:8000" not in recipe("up")


@pytest.mark.parametrize("target", ["test-e2e", "test-e2e-if-up"])
def test_e2e_targets_default_to_this_checkouts_app(target: str) -> None:
    body = recipe(target)
    assert '"$${PLAYWRIGHT_BASE_URL:-$$(scripts/stack-urls.sh app)}"' in body
    assert "localhost:8000" not in body
