"""scripts/check_local_stack.py: reading the session cookie's flags from Set-Cookie headers,
which decides whether local plain-http sign-in works (#79). No stack needed."""

from __future__ import annotations

import check_local_stack as stack

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
