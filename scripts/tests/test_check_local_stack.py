"""scripts/check_local_stack.py: reading the session cookie's flags from Set-Cookie headers,
which decides whether local plain-http sign-in works (#79), and the ports it reads from .env
(#188). No stack needed."""

from __future__ import annotations

from pathlib import Path

import check_local_stack as stack
import pytest

NAME = stack.SESSION_COOKIE


def test_finds_the_named_cookie_among_others() -> None:
    headers = [
        "other=1; Path=/; Secure",
        f"{NAME}=tok123; HttpOnly; Max-Age=2592000; Path=/; SameSite=lax",
    ]
    assert stack.find_cookie(headers, NAME) == (
        "tok123",
        {"httponly", "max-age", "path", "samesite"},
    )


def test_reports_secure_whatever_its_case_or_position() -> None:
    for header in (
        f"{NAME}=t; HttpOnly; Path=/; SameSite=lax; Secure",
        f"{NAME}=t; secure; HttpOnly",
        f"{NAME}=t;SECURE",
    ):
        found = stack.find_cookie([header], NAME)
        assert found is not None
        assert "secure" in found[1]


def test_attribute_values_do_not_count_as_flags() -> None:
    found = stack.find_cookie([f"{NAME}=t; Path=/secure; Domain=secure.example"], NAME)
    assert found == ("t", {"path", "domain"})


def test_missing_cookie_is_none() -> None:
    assert stack.find_cookie([], NAME) is None
    assert stack.find_cookie(["other=1; Path=/", f"{NAME}x=2"], NAME) is None


@pytest.mark.parametrize(
    ("env_file", "expected"),
    [
        (None, "8000"),
        ("APP_PORT=8010\n", "8010"),
        ('APP_PORT="8020"\n', "8020"),
        # Compose's .env parser also takes `export NAME=value` (#188).
        ("export APP_PORT=8010\n", "8010"),
        ("  export   APP_PORT = '8020'\n", "8020"),
        ("APP_PORT=8010\nexport APP_PORT=8020\n", "8020"),  # the last line wins
        ("exportAPP_PORT=8010\nexport OTHER_APP_PORT=8030\n", "8000"),
    ],
)
def test_setting_reads_env_file_like_compose(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, env_file: str | None, expected: str
) -> None:
    monkeypatch.delenv("APP_PORT", raising=False)
    path = tmp_path / ".env"
    if env_file is not None:
        path.write_text(env_file)
    assert stack.setting("APP_PORT", "8000", path) == expected


def test_setting_prefers_the_environment(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    path = tmp_path / ".env"
    path.write_text("export APP_PORT=8010\n")
    monkeypatch.setenv("APP_PORT", "8030")
    assert stack.setting("APP_PORT", "8000", path) == "8030"
