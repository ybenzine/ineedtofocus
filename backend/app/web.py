"""Serve the built frontend from the same origin as the API."""

import os
import re
from pathlib import Path, PurePosixPath

from fastapi import FastAPI
from fastapi.responses import FileResponse, Response
from starlette.datastructures import Headers
from starlette.types import Receive, Scope, Send

# Vite names built chunks `assets/<name>-<content hash>.<ext>` (hash: 8+ base64url characters),
# so a changed file always gets a new URL and an old URL never changes content.
_HASHED_ASSET = re.compile(r"^assets/.+-[A-Za-z0-9_-]{8,}\.[A-Za-z0-9.]+$")
IMMUTABLE = "public, max-age=31536000, immutable"
# `no-cache` lets the browser store the file but makes it revalidate on every use; an unchanged
# file is answered 304 from the ETag below. It covers the HTML shell, the service worker,
# workbox-*.js, theme-init.js and the manifest (a stale copy would pin users to an
# old release), and every other unhashed file (icons, sounds, favicon): the service worker
# precaches those, so revalidating them costs a 304 at most.
NO_CACHE = "no-cache"


class _EtagFileResponse(FileResponse):
    """A FileResponse that keeps the ETag it was given instead of Starlette's own."""

    def set_stat_headers(self, stat_result: os.stat_result) -> None:
        etag = self.headers["etag"]
        super().set_stat_headers(stat_result)
        self.headers["etag"] = etag


def _file_response(path: Path, relative: str, request_headers: Headers) -> Response:
    cache = IMMUTABLE if _HASHED_ASSET.match(relative) else NO_CACHE
    stat = path.stat()
    etag = f'"{stat.st_mtime_ns:x}-{stat.st_size:x}"'
    headers = {"Cache-Control": cache, "ETag": etag}
    # Starlette's FileResponse does not answer conditional requests (StaticFiles does).
    sent = {
        v.strip().removeprefix("W/") for v in request_headers.get("if-none-match", "").split(",")
    }
    if etag in sent:
        return Response(status_code=304, headers=headers)
    return _EtagFileResponse(path, headers=headers)


def mount_frontend(app: FastAPI, dist: Path) -> None:
    """Serve `dist` with SPA fallback to index.html. No-op when the build is absent.

    Implemented as the router's "no route matched" handler, not as a catch-all route, so
    API routes registered after `create_app()` are never shadowed, and a 404 that a route
    raises itself stays a JSON 404.
    """
    index = dist / "index.html"
    if not index.is_file():
        return
    root = dist.resolve()

    def fallback(url_path: str, request_headers: Headers) -> Response | None:
        path = url_path.lstrip("/")
        if path == "api" or path.startswith("api/"):
            return None  # unknown API paths stay a JSON 404
        candidate = (root / path).resolve()
        if path and candidate.is_file() and candidate.is_relative_to(root):
            relative = candidate.relative_to(root).as_posix()
            return _file_response(candidate, relative, request_headers)
        if path.startswith("assets/") or PurePosixPath(path).suffix:
            return None  # a missing static file is a 404, never HTML (service worker, MIME)
        return _file_response(index, "index.html", request_headers)  # client-side route

    not_found = app.router.default

    async def default(scope: Scope, receive: Receive, send: Send) -> None:
        if scope["type"] == "http" and scope["method"] == "GET":
            response = fallback(scope["path"], Headers(scope=scope))
            if response is not None:
                await response(scope, receive, send)
                return
        await not_found(scope, receive, send)

    app.router.default = default
