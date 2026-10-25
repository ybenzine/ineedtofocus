"""compose.yaml: the local app container gets every app setting with the app's own default
(#88), so editing one in .env takes effect under `make up`. No Docker: reads the file."""

from __future__ import annotations

import re
import sys
from pathlib import Path
from typing import Any

REPO = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(REPO / "backend"))

from app.config import Settings  # noqa: E402

# Settings compose.yaml sets on purpose to something other than `${NAME:-<app default>}`.
NOT_PASSED_THROUGH = {
    # Built from the POSTGRES_* values with host `db`; the .env value is for the host.
    "DATABASE_URL",
    # The image serves its own built frontend at the app's default path.
    "FRONTEND_DIST",
    # Off locally (plain http); the app defaults it on (#79).
    "COOKIE_SECURE",
}
ENTRY = re.compile(r"^ {6}([A-Z][A-Z0-9_]*): (.*)$")
PASS_THROUGH = re.compile(r"^\$\{([A-Z][A-Z0-9_]*):-([^}]*)\}$")


def app_environment() -> dict[str, str]:
    """The `environment:` mapping of compose.yaml's `app` service, as raw strings."""
    lines = (REPO / "compose.yaml").read_text().splitlines()
    start = lines.index("  app:")
    env_at = lines.index("    environment:", start)
    result: dict[str, str] = {}
    for line in lines[env_at + 1 :]:
        if line.strip().startswith("#"):
            continue
        if not line.startswith("      "):
            break
        match = ENTRY.match(line)
        assert match, f"unexpected line in the app's environment: {line!r}"
        result[match[1]] = match[2]
    return result


def parsed(name: str, raw: str) -> Any:
    """What the app makes of `raw` for setting `name`."""
    return getattr(Settings.model_validate({name.lower(): raw}), name.lower())


def test_every_app_setting_is_passed_with_the_app_default() -> None:
    env = app_environment()
    checked = 0
    for field, info in Settings.model_fields.items():
        name = field.upper()
        if name in NOT_PASSED_THROUGH:
            continue
        assert name in env, f"compose.yaml does not pass {name} to the app"
        match = PASS_THROUGH.match(env[name])
        assert match and match[1] == name, f"{name}: expected ${{{name}:-<default>}}"
        assert parsed(name, match[2]) == info.default, (
            f"{name}: compose default {match[2]!r} is not the app's {info.default!r}"
        )
        checked += 1
    assert checked >= 8  # LOG_LEVEL, READINESS_*, SESSION_TTL_DAYS, SIGNIN_* and SIGNUP_*


def test_session_and_rate_limit_settings_are_passed() -> None:
    env = app_environment()
    for name in (
        "SESSION_TTL_DAYS",
        "SIGNIN_MAX_FAILURES",
        "SIGNIN_MAX_FAILURES_PER_CLIENT",
        "SIGNIN_WINDOW_SECONDS",
        "SIGNUP_MAX_PER_CLIENT",
        "SIGNUP_WINDOW_SECONDS",
    ):
        assert env.get(name, "").startswith(f"${{{name}:-"), name


def test_env_example_lists_only_settings_the_local_stack_uses() -> None:
    """Every active app setting in .env.example reaches the app container (or is one
    compose.yaml sets itself), so editing it in .env is never silently ignored."""
    env = app_environment()
    fields = {field.upper() for field in Settings.model_fields}
    active = {
        line.partition("=")[0]
        for line in (REPO / ".env.example").read_text().splitlines()
        if line and not line.startswith("#") and "=" in line
    }
    for name in sorted(active & fields - {"DATABASE_URL"}):
        assert name in env, f".env.example lists {name}, but compose.yaml does not pass it"


# --- One stack per checkout (#83) ---------------------------------------------------------

PORT_VARIABLES = ("APP_PORT", "POSTGRES_PORT", "GRAFANA_PORT", "OTLP_GRPC_PORT", "OTLP_HTTP_PORT")


def env_example(commented: bool) -> dict[str, str]:
    """The `NAME=value` lines of .env.example: active ones, or the commented `#   NAME=value`
    example lines for a second worktree."""
    pattern = r"^#   ([A-Z][A-Z0-9_]*)=(.*)$" if commented else r"^([A-Z][A-Z0-9_]*)=(.*)$"
    text = (REPO / ".env.example").read_text()
    return {m[1]: m[2] for m in re.finditer(pattern, text, re.MULTILINE)}


def test_project_name_default_matches_compose() -> None:
    compose = (REPO / "compose.yaml").read_text()
    assert "\nname: focus-local\n" in compose
    assert env_example(commented=False)["COMPOSE_PROJECT_NAME"] == "focus-local"


def test_every_host_port_is_a_variable() -> None:
    """A second worktree can only move the ports compose.yaml reads from the environment."""
    compose = (REPO / "compose.yaml").read_text()
    published = re.findall(r'^\s+- "127\.0\.0\.1:\$\{([A-Z_]+):-(\d+)\}:\d+"', compose, re.M)
    defaults = env_example(commented=False)
    assert sorted(name for name, _ in published) == sorted(PORT_VARIABLES)
    for name, default in published:
        assert defaults[name] == default, name


def test_second_worktree_example_moves_every_port_by_ten() -> None:
    defaults = env_example(commented=False)
    second = env_example(commented=True)
    assert second["COMPOSE_PROJECT_NAME"] != defaults["COMPOSE_PROJECT_NAME"]
    for name in PORT_VARIABLES:
        assert int(second[name]) == int(defaults[name]) + 10, name
    assert second["DATABASE_URL"] == defaults["DATABASE_URL"].replace(
        f":{defaults['POSTGRES_PORT']}/", f":{second['POSTGRES_PORT']}/"
    )
