"""The #317 demo gate: saves fail only when the app runs as dev."""

import pytest

from app.sessions import _broken_build_gate

DEV = "deployment.environment.name=dev,service.version=abc1234"


@pytest.mark.parametrize(
    "attributes",
    [
        DEV,
        "service.version=abc1234, deployment.environment.name=dev",
        "deployment.environment.name=dev",
    ],
)
def test_raises_in_dev(monkeypatch: pytest.MonkeyPatch, attributes: str) -> None:
    monkeypatch.setenv("OTEL_RESOURCE_ATTRIBUTES", attributes)
    with pytest.raises(RuntimeError, match=r"deliberately broken build \(#317 on-call drill\)"):
        _broken_build_gate()


@pytest.mark.parametrize(
    "attributes",
    [
        "deployment.environment.name=prod,service.version=abc1234",
        "deployment.environment.name=local",
        "deployment.environment.name=dev2",
        "deployment.environment.name=development",
        "",
    ],
)
def test_does_nothing_elsewhere(monkeypatch: pytest.MonkeyPatch, attributes: str) -> None:
    monkeypatch.setenv("OTEL_RESOURCE_ATTRIBUTES", attributes)
    _broken_build_gate()


def test_does_nothing_when_unset(monkeypatch: pytest.MonkeyPatch) -> None:
    """CI and the unit tests run without the variable."""
    monkeypatch.delenv("OTEL_RESOURCE_ATTRIBUTES", raising=False)
    _broken_build_gate()
