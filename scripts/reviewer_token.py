#!/usr/bin/env -S uv run --quiet --locked --script
# /// script
# requires-python = ">=3.12"
# dependencies = ["pyjwt[crypto]==2.15.1", "cryptography==50.0.2"]
#
# [tool.uv]
# exclude-newer = "2026-10-21T00:00:00Z"
# ///
# Dependencies are pinned here and locked, with hashes, in reviewer_token.py.lock next to this
# file (`uv lock --script scripts/reviewer_token.py`). `make lint-scripts` and
# `make test-scripts` install the same pins. To upgrade, bump the pins and exclude-newer,
# re-lock, and commit both files.
"""Mint a short-lived installation token for the reviewer GitHub App (#70).

    uv run --quiet --locked --script scripts/reviewer_token.py

Prints the installation token on stdout and nothing else, so it can only be captured:

    GH_TOKEN="$(uv run --quiet --locked --script scripts/reviewer_token.py)" gh pr review ...

The reviewer agent doesn't call this directly: scripts/reviewer-review.sh does, and passes the
token to `gh` without it ever reaching a terminal, a log or a file. Refuses to print the token
when stdout is a terminal.

Reads (defaults match .env.example; the IDs are public, the key is not):
  REVIEWER_APP_ID            GitHub App ID                     (default 5420413)
  REVIEWER_INSTALLATION_ID   installation on ybenzine/ineedtofocus (default 173980330)
  REVIEWER_APP_KEY_PATH      the App's private key (PEM), kept outside the repo
                             (default ~/.config/ineedtofocus/reviewer-app.pem)

How: signs a 10-minute JWT (RS256, PyJWT) with the key, then exchanges it for an installation
token scoped to this repository with Pull requests write and Contents write. The token expires
after one hour. Contents write is there only so the App's approval counts toward the review that
branch protection requires (GitHub counts approvals from identities with write access).
Nothing secret is ever written to stderr: errors name the key path and GitHub's error message,
never the key, the JWT or the token.

Exit codes: 0 token printed · 1 GitHub or network error, or an unusable key ·
2 bad configuration or usage · 3 key file missing or unreadable (callers fall back to a
comment review, see _docs/process.md §4).
"""

from __future__ import annotations

import argparse
import json
import os
import stat
import sys
import time
import urllib.error
import urllib.request
from collections.abc import Callable, Mapping
from dataclasses import dataclass
from pathlib import Path
from typing import IO, Any

import jwt

DEFAULT_APP_ID = "5420413"
DEFAULT_INSTALLATION_ID = "173980330"
DEFAULT_KEY_PATH = "~/.config/ineedtofocus/reviewer-app.pem"
API_URL = "https://api.github.com"
# The token works on this repository only, with only what an approving review needs. Contents
# write makes the approval count toward branch protection's required review (#70); the accepted
# cost is that a leaked token could push to unprotected branches for up to an hour.
TOKEN_REPOSITORIES = ["ineedtofocus"]
TOKEN_PERMISSIONS = {"pull_requests": "write", "contents": "write"}
# GitHub accepts a JWT valid for at most 10 minutes; iat is backdated for clock drift.
JWT_BACKDATE_SECONDS = 60
JWT_LIFETIME_SECONDS = 540

EXIT_ERROR = 1
EXIT_CONFIG = 2
EXIT_KEY_UNAVAILABLE = 3

Opener = Callable[..., Any]


class TokenError(Exception):
    """A failure with a message that is safe to print (no key, JWT or token in it)."""

    def __init__(self, message: str, exit_code: int = EXIT_ERROR) -> None:
        super().__init__(message)
        self.exit_code = exit_code


@dataclass(frozen=True)
class Config:
    app_id: str
    installation_id: str
    key_path: Path


def load_config(env: Mapping[str, str]) -> Config:
    """Read the App settings from the environment, falling back to the documented defaults."""
    app_id = env.get("REVIEWER_APP_ID") or DEFAULT_APP_ID
    installation_id = env.get("REVIEWER_INSTALLATION_ID") or DEFAULT_INSTALLATION_ID
    for name, value in (
        ("REVIEWER_APP_ID", app_id),
        ("REVIEWER_INSTALLATION_ID", installation_id),
    ):
        if not value.isdigit():
            raise TokenError(f"{name} must be a number, got {value!r}", EXIT_CONFIG)
    key_path = Path(env.get("REVIEWER_APP_KEY_PATH") or DEFAULT_KEY_PATH).expanduser()
    return Config(app_id=app_id, installation_id=installation_id, key_path=key_path)


def read_key(path: Path, warn: IO[str]) -> bytes:
    """Return the private key's bytes. Never includes them in an error."""
    try:
        mode = path.stat().st_mode
        data = path.read_bytes()
    except FileNotFoundError:
        raise TokenError(
            f"reviewer App key not found at {path} (set REVIEWER_APP_KEY_PATH)",
            EXIT_KEY_UNAVAILABLE,
        ) from None
    except OSError as exc:
        raise TokenError(
            f"cannot read the reviewer App key at {path}: {exc.strerror}",
            EXIT_KEY_UNAVAILABLE,
        ) from None
    if not stat.S_ISREG(mode):
        raise TokenError(f"reviewer App key at {path} is not a file", EXIT_KEY_UNAVAILABLE)
    if mode & 0o077:
        warn.write(f"warning: {path} is readable by other users; run: chmod 600 {path}\n")
    return data


def make_jwt(app_id: str, key: bytes, now: int) -> str:
    """Sign the short-lived App JWT (RS256) that GitHub exchanges for an installation token."""
    payload = {
        "iat": now - JWT_BACKDATE_SECONDS,
        "exp": now + JWT_LIFETIME_SECONDS,
        "iss": app_id,
    }
    try:
        return jwt.encode(payload, key, algorithm="RS256")
    except Exception as exc:  # broad on purpose: the message could echo key material; drop it
        raise TokenError(
            f"the reviewer App key is not a usable RSA private key ({type(exc).__name__})"
        ) from None


def _github_message(exc: urllib.error.HTTPError) -> str:
    """GitHub's error `message` field (never secret), or the HTTP reason."""
    try:
        body = json.loads(exc.read().decode("utf-8", "replace"))
    except (ValueError, OSError):
        return str(exc.reason)
    message = body.get("message") if isinstance(body, dict) else None
    return str(message) if message else str(exc.reason)


def request_installation_token(
    app_jwt: str,
    installation_id: str,
    *,
    api_url: str = API_URL,
    opener: Opener = urllib.request.urlopen,
) -> str:
    """POST /app/installations/{id}/access_tokens and return the token."""
    body = json.dumps(
        {"repositories": TOKEN_REPOSITORIES, "permissions": TOKEN_PERMISSIONS}
    ).encode()
    request = urllib.request.Request(
        f"{api_url}/app/installations/{installation_id}/access_tokens",
        data=body,
        method="POST",
        headers={
            "Accept": "application/vnd.github+json",
            "Authorization": f"Bearer {app_jwt}",
            "Content-Type": "application/json",
            "User-Agent": "ineedtofocus-reviewer-token",
            "X-GitHub-Api-Version": "2022-11-28",
        },
    )
    try:
        with opener(request, timeout=30) as response:
            payload = json.load(response)
    except urllib.error.HTTPError as exc:
        raise TokenError(
            f"GitHub refused the installation token request: HTTP {exc.code}: "
            f"{_github_message(exc)}"
        ) from None
    except urllib.error.URLError as exc:
        raise TokenError(f"cannot reach GitHub: {exc.reason}") from None
    except (ValueError, OSError) as exc:
        raise TokenError(f"bad response from GitHub ({type(exc).__name__})") from None
    token = payload.get("token") if isinstance(payload, dict) else None
    if not isinstance(token, str) or not token:
        raise TokenError("GitHub's response has no installation token")
    return token


def main(
    argv: list[str] | None = None,
    *,
    env: Mapping[str, str] | None = None,
    stdout: IO[str] | None = None,
    stderr: IO[str] | None = None,
    now: Callable[[], float] = time.time,
    opener: Opener = urllib.request.urlopen,
) -> int:
    out = stdout if stdout is not None else sys.stdout
    err = stderr if stderr is not None else sys.stderr
    parser = argparse.ArgumentParser(
        description="Print an installation token for the reviewer GitHub App on stdout.",
        epilog=(
            "Capture it: "
            'GH_TOKEN="$(uv run --quiet --locked --script scripts/reviewer_token.py)" gh ...'
        ),
    )
    parser.parse_args(argv)
    try:
        if out.isatty():
            raise TokenError(
                "stdout is a terminal; capture the token instead of printing it "
                "(or use scripts/reviewer-review.sh)",
                EXIT_CONFIG,
            )
        config = load_config(os.environ if env is None else env)
        key = read_key(config.key_path, err)
        app_jwt = make_jwt(config.app_id, key, int(now()))
        token = request_installation_token(app_jwt, config.installation_id, opener=opener)
    except TokenError as exc:
        err.write(f"reviewer_token: {exc}\n")
        return exc.exit_code
    out.write(token + "\n")
    return 0


if __name__ == "__main__":
    sys.exit(main())
