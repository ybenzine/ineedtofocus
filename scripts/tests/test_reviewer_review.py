"""scripts/reviewer-review.sh: posts the review as the App when a token can be minted, falls
back to a COMMENT review from the default gh login when the key is unavailable (exit 3), and
posts nothing on any other failure. `uv` and `gh` are fakes on PATH: no network, no key."""

from __future__ import annotations

import os
import subprocess
from pathlib import Path

import pytest

SCRIPT = Path(__file__).resolve().parents[1] / "reviewer-review.sh"
FAKE_TOKEN = "ghs_fake_token_for_tests"
REVIEW_CMD = ["pr", "review", "71", "--repo", "ybenzine/ineedtofocus"]

FAKE_UV = """#!/usr/bin/env bash
# Stands in for `uv run --quiet --script scripts/reviewer_token.py`.
printf '%s\\n' "$*" > "$FAKE_DIR/uv.args"
if [[ "$FAKE_UV_EXIT" == 0 ]]; then echo "$FAKE_TOKEN"; else echo "simulated failure" >&2; fi
exit "$FAKE_UV_EXIT"
"""

FAKE_GH = """#!/usr/bin/env bash
# Records its arguments and whether it got GH_TOKEN.
printf '%s\\n' "$@" > "$FAKE_DIR/gh.args"
printf '%s' "${GH_TOKEN-<unset>}" > "$FAKE_DIR/gh.token"
"""


@pytest.fixture
def fakes(tmp_path: Path) -> Path:
    bin_dir = tmp_path / "bin"
    bin_dir.mkdir()
    for name, body in (("uv", FAKE_UV), ("gh", FAKE_GH)):
        path = bin_dir / name
        path.write_text(body)
        path.chmod(0o755)
    return tmp_path


@pytest.fixture
def body_file(tmp_path: Path) -> Path:
    path = tmp_path / "review.md"
    path.write_text("**Reviewer agent — review**\n\n**Verdict: Approve**\n")
    return path


def run(
    fakes: Path, *args: str, uv_exit: int = 0, extra_env: dict[str, str] | None = None
) -> subprocess.CompletedProcess[str]:
    env = {k: v for k, v in os.environ.items() if not k.startswith(("GH_", "GITHUB_", "REVIEWER_"))}
    env.update(
        PATH=f"{fakes / 'bin'}{os.pathsep}{env['PATH']}",
        FAKE_DIR=str(fakes),
        FAKE_TOKEN=FAKE_TOKEN,
        FAKE_UV_EXIT=str(uv_exit),
        **(extra_env or {}),
    )
    return subprocess.run(
        ["bash", str(SCRIPT), *args], env=env, capture_output=True, text=True, check=False
    )


def gh_args(fakes: Path) -> list[str]:
    return (fakes / "gh.args").read_text().splitlines()


@pytest.mark.parametrize(
    ("verdict", "flag"),
    [("approve", "--approve"), ("request-changes", "--request-changes"), ("comment", "--comment")],
)
def test_posts_the_review_as_the_app(fakes: Path, body_file: Path, verdict: str, flag: str) -> None:
    result = run(fakes, "71", verdict, str(body_file))

    assert result.returncode == 0, result.stderr
    assert gh_args(fakes) == [*REVIEW_CMD, flag, "--body-file", str(body_file)]
    assert (fakes / "gh.token").read_text() == FAKE_TOKEN
    assert "--script" in (fakes / "uv.args").read_text()
    # The token goes to gh's environment only, never to the output.
    assert FAKE_TOKEN not in result.stdout + result.stderr
    assert "as the reviewer App" in result.stdout


def test_rest_mode_posts_through_the_reviews_endpoint(fakes: Path, body_file: Path) -> None:
    result = run(
        fakes, "71", "request-changes", str(body_file), extra_env={"REVIEWER_REVIEW_API": "rest"}
    )

    assert result.returncode == 0, result.stderr
    args = gh_args(fakes)
    assert args[:4] == ["api", "--method", "POST", "repos/ybenzine/ineedtofocus/pulls/71/reviews"]
    assert "event=REQUEST_CHANGES" in args
    assert f"body=@{body_file}" in args
    assert (fakes / "gh.token").read_text() == FAKE_TOKEN


def test_missing_key_falls_back_to_a_comment_review(fakes: Path, body_file: Path) -> None:
    result = run(fakes, "71", "approve", str(body_file), uv_exit=3)

    assert result.returncode == 0, result.stderr
    assert gh_args(fakes) == [*REVIEW_CMD, "--comment", "--body-file", str(body_file)]
    # Posted with the default gh login, not an App token.
    assert (fakes / "gh.token").read_text() == "<unset>"
    assert "Fallback" in result.stderr
    assert "Yacine" in result.stderr


def test_other_token_failures_post_nothing(fakes: Path, body_file: Path) -> None:
    result = run(fakes, "71", "approve", str(body_file), uv_exit=1)

    assert result.returncode == 1
    assert not (fakes / "gh.args").exists()
    assert "no review posted" in result.stderr


@pytest.mark.parametrize(
    "args",
    [
        ["71", "approve"],
        ["seventy", "approve", "BODY"],
        ["71", "merge", "BODY"],
        ["71", "approve", "/nonexistent/review.md"],
    ],
)
def test_bad_usage_exits_2_without_posting(fakes: Path, body_file: Path, args: list[str]) -> None:
    result = run(fakes, *[str(body_file) if a == "BODY" else a for a in args])

    assert result.returncode == 2
    assert not (fakes / "gh.args").exists()
    assert not (fakes / "uv.args").exists()


def test_empty_body_file_is_rejected(fakes: Path, tmp_path: Path) -> None:
    empty = tmp_path / "empty.md"
    empty.write_text("")

    result = run(fakes, "71", "approve", str(empty))

    assert result.returncode == 2
    assert not (fakes / "gh.args").exists()
