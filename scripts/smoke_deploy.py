#!/usr/bin/env python3
"""Smoke-test a deployed environment from outside, after a deploy (#28).

    python3 scripts/smoke_deploy.py https://dev.ineedtofoc.us [--summary FILE]

Checks, through Caddy and the public DNS name, each retried until --timeout runs out
(the app may still be settling behind Caddy):

    GET /healthz        200 {"status": "ok"}     the app process is up
    GET /readyz         200 {"status": "ok"}     it reaches its database
    GET /               200, an HTML document    the built frontend is served
    GET http://<host>/  301/308 to https://<host>/   only for an https:// URL

HTTPS certificates are verified against the system trust store, so an expired or
self-signed certificate fails. Prints one line per check and exits 1 if any failed.
With --summary, appends a Markdown table of the results (the workflow passes
$GITHUB_STEP_SUMMARY). Standard library only: the deploy job runs it with the runner's
Python, without installing anything.
"""

from __future__ import annotations

import argparse
import json
import sys
import time
import urllib.error
import urllib.request
from collections.abc import Callable
from dataclasses import dataclass
from pathlib import Path
from urllib.parse import urlsplit

USER_AGENT = "focus-smoke-deploy/1"


@dataclass(frozen=True)
class Result:
    name: str
    ok: bool
    detail: str


@dataclass(frozen=True)
class Response:
    status: int
    headers: dict[str, str]
    body: bytes


class _NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, *args: object, **kwargs: object) -> None:
        return None


_OPENER = urllib.request.build_opener(_NoRedirect)


def fetch(url: str, timeout: float = 10) -> Response:
    """GET url without following redirects; HTTP error statuses are returned, not raised."""
    request = urllib.request.Request(url, headers={"User-Agent": USER_AGENT})
    try:
        with _OPENER.open(request, timeout=timeout) as response:
            return Response(
                response.status,
                {k.lower(): v for k, v in response.headers.items()},
                response.read(1_000_000),
            )
    except urllib.error.HTTPError as error:
        return Response(
            error.code,
            {k.lower(): v for k, v in error.headers.items()},
            error.read(1_000_000),
        )


Check = Callable[[], str | None]  # None when it passes, else what went wrong


def status_ok(url: str) -> Check:
    def check() -> str | None:
        response = fetch(url)
        if response.status != 200:
            return f"HTTP {response.status}: {response.body[:200]!r}"
        try:
            body = json.loads(response.body)
        except ValueError:
            return f"not JSON: {response.body[:200]!r}"
        if body != {"status": "ok"}:
            return f"unexpected body: {body!r}"
        return None

    return check


def serves_html(url: str) -> Check:
    def check() -> str | None:
        response = fetch(url)
        if response.status != 200:
            return f"HTTP {response.status}"
        if "text/html" not in response.headers.get("content-type", ""):
            return f"content-type {response.headers.get('content-type')!r}, not text/html"
        if b"<!doctype html" not in response.body[:500].lower():
            return "no <!doctype html> at the start of the body"
        return None

    return check


def redirects_to(url: str, target_prefix: str) -> Check:
    def check() -> str | None:
        response = fetch(url)
        location = response.headers.get("location", "")
        if response.status not in (301, 308):
            return f"HTTP {response.status}, expected a 301/308 redirect"
        if not location.startswith(target_prefix):
            return f"redirects to {location!r}, expected {target_prefix}..."
        return None

    return check


def retry(check: Check, deadline: float, interval: float) -> str | None:
    """Run check until it passes or the deadline passes; returns the last error."""
    while True:
        try:
            error = check()
        except (OSError, urllib.error.URLError) as exc:  # DNS, TLS, refused, timeout
            error = f"{type(exc).__name__}: {exc}"
        if error is None or time.monotonic() >= deadline:
            return error
        time.sleep(interval)


def checks_for(base_url: str) -> list[tuple[str, Check]]:
    base = base_url.rstrip("/")
    checks: list[tuple[str, Check]] = [
        ("GET /healthz", status_ok(f"{base}/healthz")),
        ("GET /readyz", status_ok(f"{base}/readyz")),
        ("GET / (frontend)", serves_html(f"{base}/")),
    ]
    parts = urlsplit(base)
    if parts.scheme == "https":
        checks.append(
            (
                "http:// redirects to https://",
                redirects_to(f"http://{parts.netloc}/", f"https://{parts.netloc}/"),
            )
        )
    return checks


def run(checks: list[tuple[str, Check]], timeout: float, interval: float) -> list[Result]:
    deadline = time.monotonic() + timeout
    results = []
    for name, check in checks:
        error = retry(check, deadline, interval)
        results.append(Result(name, error is None, error or "ok"))
    return results


def summary_markdown(base_url: str, results: list[Result]) -> str:
    lines = [
        f"#### Smoke tests against {base_url}",
        "",
        "| Check | Result |",
        "|---|---|",
    ]
    for result in results:
        mark = "pass" if result.ok else "FAIL"
        detail = result.detail.replace("|", "\\|").replace("\n", " ")
        lines.append(f"| {result.name} | {mark}{'' if result.ok else ': ' + detail} |")
    return "\n".join(lines) + "\n"


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    parser.add_argument("base_url", help="e.g. https://dev.ineedtofoc.us")
    parser.add_argument("--timeout", type=float, default=90, help="seconds for all checks")
    parser.add_argument("--interval", type=float, default=3, help="seconds between retries")
    parser.add_argument("--summary", type=Path, help="append a Markdown table here")
    args = parser.parse_args(argv)
    if urlsplit(args.base_url).scheme not in ("http", "https"):
        parser.error("base_url must start with http:// or https://")

    results = run(checks_for(args.base_url), args.timeout, args.interval)
    for result in results:
        print(f"{'ok  ' if result.ok else 'FAIL'}  {result.name}: {result.detail}")
    if args.summary:
        with args.summary.open("a", encoding="utf-8") as summary:
            summary.write(summary_markdown(args.base_url, results))
    return 0 if all(result.ok for result in results) else 1


if __name__ == "__main__":
    sys.exit(main())
