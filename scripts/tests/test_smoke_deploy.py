"""scripts/smoke_deploy.py: the post-deploy smoke checks (#28), against a local HTTP server
that plays a healthy app, a broken one and Caddy's http->https redirect."""

from __future__ import annotations

import json
import threading
from collections.abc import Iterator
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

import pytest
import smoke_deploy
from smoke_deploy import checks_for, main, redirects_to, run, summary_markdown

Routes = dict[str, tuple[int, dict[str, str], bytes]]

HEALTHY: Routes = {
    "/healthz": (200, {"Content-Type": "application/json"}, b'{"status":"ok"}'),
    "/readyz": (200, {"Content-Type": "application/json"}, b'{"status":"ok"}'),
    "/": (200, {"Content-Type": "text/html; charset=utf-8"}, b"<!DOCTYPE html><html></html>"),
}


class Server:
    def __init__(self) -> None:
        self.routes: Routes = dict(HEALTHY)
        self.hits: list[str] = []
        outer = self

        class Handler(BaseHTTPRequestHandler):
            def do_GET(self) -> None:
                outer.hits.append(self.path)
                status, headers, body = outer.routes.get(self.path, (404, {}, b"not found"))
                self.send_response(status)
                for name, value in headers.items():
                    self.send_header(name, value)
                self.send_header("Content-Length", str(len(body)))
                self.end_headers()
                self.wfile.write(body)

            def log_message(self, format: str, *args: object) -> None:
                pass

        self.httpd = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        self.url = f"http://127.0.0.1:{self.httpd.server_address[1]}"
        threading.Thread(target=self.httpd.serve_forever, daemon=True).start()


@pytest.fixture
def server() -> Iterator[Server]:
    s = Server()
    yield s
    s.httpd.shutdown()
    s.httpd.server_close()


def test_healthy_app_passes(server: Server, tmp_path: Path) -> None:
    summary = tmp_path / "summary.md"
    assert (
        main([server.url, "--timeout", "1", "--interval", "0.05", "--summary", str(summary)]) == 0
    )
    assert {"/healthz", "/readyz", "/"} <= set(server.hits)
    text = summary.read_text()
    assert f"Smoke tests against {server.url}" in text
    assert text.count("| pass") == 3


@pytest.mark.parametrize(
    ("path", "response", "expected"),
    [
        ("/healthz", (502, {}, b"bad gateway"), "HTTP 502"),
        ("/readyz", (503, {"Content-Type": "application/json"}, b'{"error":"down"}'), "HTTP 503"),
        (
            "/readyz",
            (200, {"Content-Type": "application/json"}, b'{"status":"degraded"}'),
            "unexpected body",
        ),
        ("/healthz", (200, {"Content-Type": "text/plain"}, b"ok"), "not JSON"),
        ("/", (200, {"Content-Type": "application/json"}, b"{}"), "not text/html"),
        ("/", (200, {"Content-Type": "text/html"}, b"<p>hi</p>"), "no <!doctype html>"),
        ("/", (404, {}, b""), "HTTP 404"),
    ],
)
def test_each_broken_answer_fails(
    server: Server, path: str, response: tuple[int, dict[str, str], bytes], expected: str
) -> None:
    server.routes[path] = response
    results = run(checks_for(server.url), timeout=0.2, interval=0.05)
    failed = [r for r in results if not r.ok]
    assert len(failed) == 1
    assert expected in failed[0].detail
    assert main([server.url, "--timeout", "0.2", "--interval", "0.05"]) == 1


def test_retries_until_the_app_answers(server: Server) -> None:
    """Right after the container swap Caddy may answer 502 for a moment."""
    server.routes["/healthz"] = (502, {}, b"")

    def heal() -> None:
        server.routes["/healthz"] = HEALTHY["/healthz"]

    timer = threading.Timer(0.3, heal)
    timer.start()
    try:
        results = run(checks_for(server.url), timeout=5, interval=0.05)
    finally:
        timer.cancel()
    assert all(r.ok for r in results), results
    assert server.hits.count("/healthz") > 1


def test_unreachable_host_fails_with_the_error() -> None:
    results = run(checks_for("http://127.0.0.1:9"), timeout=0.1, interval=0.05)
    assert not any(r.ok for r in results)
    assert all("Error" in r.detail for r in results)


def test_https_url_adds_the_redirect_check() -> None:
    names = [name for name, _ in checks_for("https://dev.ineedtofoc.us")]
    assert names[-1] == "http:// redirects to https://"
    assert len(checks_for("http://localhost:8000")) == 3


def test_redirect_check(server: Server) -> None:
    good = redirects_to(f"{server.url}/r", "https://dev.ineedtofoc.us/")
    server.routes["/r"] = (308, {"Location": "https://dev.ineedtofoc.us/"}, b"")
    assert good() is None
    server.routes["/r"] = (308, {"Location": "https://evil.example/"}, b"")
    assert "evil.example" in (good() or "")
    server.routes["/r"] = (200, {}, b"")
    assert "expected a 301/308" in (good() or "")


def test_https_checks_build_the_right_urls(monkeypatch: pytest.MonkeyPatch) -> None:
    seen: list[str] = []

    def fake_fetch(url: str, timeout: float = 10) -> smoke_deploy.Response:
        seen.append(url)
        if url.startswith("http://"):
            return smoke_deploy.Response(308, {"location": "https://dev.ineedtofoc.us/"}, b"")
        if url.endswith("/"):
            return smoke_deploy.Response(200, {"content-type": "text/html"}, b"<!doctype html>")
        return smoke_deploy.Response(200, {}, json.dumps({"status": "ok"}).encode())

    monkeypatch.setattr(smoke_deploy, "fetch", fake_fetch)
    assert all(r.ok for r in run(checks_for("https://dev.ineedtofoc.us/"), 1, 0.01))
    assert seen == [
        "https://dev.ineedtofoc.us/healthz",
        "https://dev.ineedtofoc.us/readyz",
        "https://dev.ineedtofoc.us/",
        "http://dev.ineedtofoc.us/",
    ]


def test_summary_escapes_table_cells() -> None:
    text = summary_markdown(
        "https://x",
        [
            smoke_deploy.Result("GET /", False, "a | b\nc"),
            smoke_deploy.Result("GET /readyz", True, "ok"),
        ],
    )
    assert "| GET / | FAIL: a \\| b c |" in text
    assert "| GET /readyz | pass |" in text


def test_rejects_a_url_without_scheme() -> None:
    with pytest.raises(SystemExit):
        main(["dev.ineedtofoc.us"])
