"""Operator-only fault injection, the alert trigger (#33): off by default, set only from the
environment at startup, never reachable through the API."""

import json
import logging
import re
from pathlib import Path

import pytest
from fastapi.testclient import TestClient
from pydantic import ValidationError

from app.config import Settings
from app.faults import InjectedSaveFault, maybe_fail_save
from app.main import create_app


async def _up() -> bool:
    return True


def test_off_by_default() -> None:
    assert Settings().fault_save_error_percent == 0
    maybe_fail_save(Settings().fault_save_error_percent, draw=lambda: 0.0)  # never fails


def test_read_from_the_environment(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("FAULT_SAVE_ERROR_PERCENT", "30")
    assert Settings().fault_save_error_percent == 30


@pytest.mark.parametrize("value", ["-1", "100.5", "lots"])
def test_out_of_range_values_stop_the_app_starting(
    monkeypatch: pytest.MonkeyPatch, value: str
) -> None:
    monkeypatch.setenv("FAULT_SAVE_ERROR_PERCENT", value)
    with pytest.raises(ValidationError):
        Settings()


@pytest.mark.parametrize(
    ("percent", "draw", "fails"),
    [
        (0, 0.0, False),
        (100, 0.999999, True),
        (25, 0.2499, True),
        (25, 0.25, False),
        (25, 0.9, False),
    ],
)
def test_fails_the_chosen_share(percent: float, draw: float, fails: bool) -> None:
    if fails:
        with pytest.raises(InjectedSaveFault):
            maybe_fail_save(percent, draw=lambda: draw)
    else:
        maybe_fail_save(percent, draw=lambda: draw)


def test_share_over_many_draws() -> None:
    import random

    rng = random.Random(33)
    failures = 0
    for _ in range(10_000):
        try:
            maybe_fail_save(20, draw=rng.random)
        except InjectedSaveFault:
            failures += 1
    assert 1800 < failures < 2200


def test_no_endpoint_exposes_or_changes_it(tmp_path: Path) -> None:
    """Only the environment sets it: no route, parameter or schema mentions it."""
    app = create_app(
        Settings(frontend_dist=tmp_path, fault_save_error_percent=50), readiness_check=_up
    )
    # Whole words only: "defaults" is fine.
    names = re.compile(r"fault_save|\bfaults?\b|\binjected", re.I)
    assert not names.search(json.dumps(app.openapi()))
    paths = [getattr(r, "path", "") for r in app.routes]
    assert not [p for p in paths if names.search(p)]
    with TestClient(app) as c:
        assert not names.search(c.get("/openapi.json").text)


def test_startup_warns_when_on(tmp_path: Path, caplog: pytest.LogCaptureFixture) -> None:
    for percent, warned in ((0, False), (40, True)):
        caplog.clear()
        app = create_app(
            Settings(frontend_dist=tmp_path, fault_save_error_percent=percent),
            readiness_check=_up,
        )
        logging.getLogger("app.main").addHandler(caplog.handler)
        try:
            with TestClient(app):
                pass
        finally:
            logging.getLogger("app.main").removeHandler(caplog.handler)
        found = [r for r in caplog.records if r.getMessage().startswith("fault injection on")]
        assert bool(found) is warned
        if warned:
            assert found[0].levelno == logging.WARNING
            assert found[0].__dict__["fault_save_error_percent"] == percent
