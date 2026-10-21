"""Serve the built frontend from the same origin as the API."""

from pathlib import Path

from fastapi import FastAPI
from fastapi.responses import FileResponse, Response


def mount_frontend(app: FastAPI, dist: Path) -> None:
    """Serve `dist` with SPA fallback to index.html. No-op when the build is absent.

    Implemented as a fallback for requests no route matched (see errors.py), not as a
    catch-all route, so API routes registered after `create_app()` are never shadowed.
    """
    index = dist / "index.html"
    if not index.is_file():
        return
    root = dist.resolve()

    def fallback(url_path: str) -> Response | None:
        path = url_path.lstrip("/")
        if path == "api" or path.startswith("api/"):
            return None  # unknown API paths stay a JSON 404
        candidate = (root / path).resolve()
        if path and candidate.is_file() and candidate.is_relative_to(root):
            return FileResponse(candidate)
        return FileResponse(index)

    app.state.spa_fallback = fallback
