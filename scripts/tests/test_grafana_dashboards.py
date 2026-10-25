"""Key-journey dashboards (#32): the JSON in infra/grafana/ is current, each dashboard sees
only its own environment and only the metrics _docs/observability.md promises, the local
stack provisions the local one, and the Grafana tokens stay where #32 put them.
No Docker or Grafana: `make check-stack` runs the queries against the real backends."""

from __future__ import annotations

import json
import re
from collections.abc import Callable
from pathlib import Path
from typing import Any

import grafana_dashboards as g
import pytest
import yaml  # type: ignore[import-untyped]  # no stubs in the locked env

REPO = Path(__file__).resolve().parents[2]
OBSERVABILITY = (REPO / "_docs" / "observability.md").read_text()
DEPLOYED = ("prod", "dev")
# Selectors in PromQL: `metric{labels}`.
PROM_SELECTOR = re.compile(r"\b([a-z_][a-z0-9_]*)\{([^}]*)\}")
SUFFIXES = re.compile(r"_(bucket|count|sum)$")


def all_targets(model: dict[str, Any]) -> list[dict[str, Any]]:
    return [t for _, t in g.targets(model)]


def test_committed_json_is_what_the_script_generates() -> None:
    assert g.stale() == [], "run python3 scripts/grafana_dashboards.py and commit the result"


@pytest.mark.parametrize("env", g.ENVIRONMENTS)
def test_committed_json_parses_to_the_model(env: str) -> None:
    assert json.loads(g.path(env).read_text()) == g.dashboard(env)


@pytest.mark.parametrize("env", g.ENVIRONMENTS)
def test_every_query_filters_on_its_own_environment(env: str) -> None:
    model = g.dashboard(env)
    for target in all_targets(model):
        kind = target["datasource"]["type"]
        if kind == "prometheus":
            selectors = PROM_SELECTOR.findall(target["expr"])
            assert selectors, target["expr"]
            for metric, labels in selectors:
                assert f'deployment_environment_name="{env}"' in labels, (metric, target["expr"])
                assert f'service_name="{g.SERVICE}"' in labels, (metric, target["expr"])
        elif kind == "loki":
            assert (
                f'{{service_name="{g.SERVICE}"}} | deployment_environment_name="{env}"'
                in target["expr"]
            )
        else:
            assert kind == "tempo"
            assert f'resource.deployment.environment.name="{env}"' in target["query"]
    other = {"prod": "dev", "dev": "prod", "local": "prod"}[env]
    assert f'"{other}"' not in json.dumps(
        [t.get("expr", t.get("query")) for t in all_targets(model)]
    )


def test_metrics_are_the_ones_observability_md_documents() -> None:
    """The dashboards and the backend (#31) share one contract: _docs/observability.md."""
    used = set()
    for target in all_targets(g.dashboard("prod")):
        if target["datasource"]["type"] == "prometheus":
            used |= {SUFFIXES.sub("", m) for m, _ in PROM_SELECTOR.findall(target["expr"])}
    assert used == {
        g.SAVES,
        g.SAVE_DURATION,
        g.HISTORY_LOADS,
        g.HISTORY_DURATION,
        g.SYNC_BATCH,
        g.HTTP_DURATION,
    }
    for metric in used:
        assert f"`{metric}" in OBSERVABILITY, (
            f"{metric} is not documented in _docs/observability.md"
        )


def test_labels_are_the_ones_the_backend_emits() -> None:
    """#31's labels (backend/app/metrics.py): `kind` and `outcome`, and FastAPI's
    `http_route` / `http_response_status_code`; never a user, tag or time zone."""
    allowed = {
        "le",
        "kind",
        "outcome",
        "http_route",
        "http_response_status_code",
        "service_name",
        "deployment_environment_name",
    }
    for target in all_targets(g.dashboard("prod")):
        if target["datasource"]["type"] != "prometheus":
            continue
        expr = target["expr"]
        grouped = {
            label.strip()
            for group in re.findall(r"by \(([^)]*)\)", expr)
            for label in group.split(",")
        }
        matched = {
            m.split("=")[0].strip()
            for _, labels in PROM_SELECTOR.findall(expr)
            for m in re.split(r",\s*(?=[a-z_]+=)", labels)
        }
        assert grouped | matched <= allowed, expr
    outcomes = " ".join(str(t.get("expr")) for t in all_targets(g.dashboard("prod")))
    assert 'outcome="error"' in outcomes


@pytest.mark.parametrize("env", g.ENVIRONMENTS)
def test_data_sources_come_from_variables_with_the_right_defaults(env: str) -> None:
    model = g.dashboard(env)
    variables = {v["name"]: v for v in model["templating"]["list"]}
    expected = g.DATASOURCES["local" if env == "local" else "cloud"]
    assert {name: v["current"]["value"] for name, v in variables.items()} == expected
    assert {name: v["query"] for name, v in variables.items()} == g.DS_TYPES
    for panel in model["panels"]:
        if panel["type"] != "row":
            assert panel["datasource"]["uid"] in {"${metrics}", "${logs}", "${traces}"}, panel[
                "title"
            ]
    for target in all_targets(model):
        assert target["datasource"]["uid"] == f"${{{_variable(target['datasource']['type'])}}}"


def _variable(ds_type: str) -> str:
    return {v: k for k, v in g.DS_TYPES.items()}[ds_type]


def test_cloud_data_source_uids_are_grafana_clouds_and_local_ones_lgtms() -> None:
    assert g.DATASOURCES["cloud"] == {
        "metrics": "grafanacloud-prom",
        "logs": "grafanacloud-logs",
        "traces": "grafanacloud-traces",
    }
    assert g.DATASOURCES["local"] == {"metrics": "prometheus", "logs": "loki", "traces": "tempo"}


@pytest.mark.parametrize("env", g.ENVIRONMENTS)
def test_layout_has_unique_ids_and_no_overlap(env: str) -> None:
    model = g.dashboard(env)
    assert model["uid"] == f"focus-key-journey-{env}"
    panels = model["panels"]
    assert [p["id"] for p in panels] == list(range(1, len(panels) + 1))
    cells: set[tuple[int, int]] = set()
    for p in panels:
        pos = p["gridPos"]
        assert pos["x"] >= 0 and pos["x"] + pos["w"] <= 24, p["title"]
        mine = {
            (x, y)
            for x in range(pos["x"], pos["x"] + pos["w"])
            for y in range(pos["y"], pos["y"] + pos["h"])
        }
        assert not cells & mine, f"{p['title']} overlaps another panel"
        cells |= mine


def test_the_dashboard_covers_the_issue() -> None:
    """#32: save success rate, save latency, history latency, error logs, links to traces."""
    model = g.dashboard("prod")
    titles = [p["title"] for p in model["panels"]]
    for wanted in ("Save success rate", "Save latency", "History latency", "Error logs"):
        assert any(t.startswith(wanted) for t in titles), wanted
    by_type = {p["type"] for p in model["panels"] if p.get("datasource", {}).get("type") == "tempo"}
    assert by_type == {"table"}, "a traces table (TraceQL) links each failed request to its trace"
    latency = [
        p for p in model["panels"] if "latency" in p["title"].lower() and p["type"] == "timeseries"
    ]
    assert latency and all(t["exemplar"] for p in latency for t in p["targets"])
    table = next(p for p in model["panels"] if p["title"] == "Error logs with their traces")
    links = table["fieldConfig"]["overrides"][0]["properties"][0]["value"]
    assert "${__data.fields.trace_id}" in links[0]["url"]


def test_trace_link_opens_explore_on_the_trace() -> None:
    url = g.explore_trace_url("${traces}")
    prefix = "/explore?schemaVersion=1&panes="
    assert url.startswith(prefix)
    pane = json.loads(url[len(prefix) :])["trace"]
    assert pane["queries"][0] == {
        "refId": "A",
        "datasource": {"type": "tempo", "uid": "${traces}"},
        "queryType": "traceql",
        "query": "${__data.fields.trace_id}",
    }


def test_alert_thresholds_match_observability_md() -> None:
    """The lines the panels draw are the alert rules' conditions (#33, observability.md)."""
    assert g.SAVE_SUCCESS_TARGET == 0.95 and "More than 5% of the sessions" in OBSERVABILITY
    assert "`$A > 0.05 && $B >= 10`" in OBSERVABILITY
    assert g.HISTORY_P95_LIMIT_S == 2 and "is above 2 s" in OBSERVABILITY
    assert "`$A > 2`" in OBSERVABILITY


def test_local_stack_provisions_the_local_dashboard() -> None:
    compose = yaml.safe_load((REPO / "compose.yaml").read_text())
    mounts = {}
    for volume in compose["services"]["lgtm"]["volumes"]:
        source, target, mode = volume.split(":")
        assert mode == "ro"
        assert (REPO / source).is_file(), source
        mounts[target] = source
    provider_file = "/otel-lgtm/grafana/conf/provisioning/dashboards/focus.yaml"
    assert mounts[provider_file] == "./infra/grafana/provisioning/dashboards.yaml"
    provider = yaml.safe_load((REPO / "infra/grafana/provisioning/dashboards.yaml").read_text())
    folder = provider["providers"][0]["options"]["path"]
    assert (
        mounts[f"{folder}/key-journey-local.json"]
        == "./infra/grafana/dashboards/key-journey-local.json"
    )
    # Only the local dashboard: prod and dev have no data in the local stack.
    assert not [t for t in mounts if t.startswith(folder) and not t.endswith("-local.json")]


def test_grafana_tokens_stay_out_of_git_and_out_of_ci() -> None:
    """The OTLP token lives only in the server's .env files; the read-only token only in the
    `oncall` environment (#32, #35)."""
    for workflow in sorted((REPO / ".github" / "workflows").glob("*.y*ml")):
        text = workflow.read_text()
        assert "GRAFANA_CLOUD_OTLP_TOKEN" not in text, workflow.name
        for name, job in (yaml.safe_load(text).get("jobs") or {}).items():
            if "GRAFANA_READONLY_TOKEN" in json.dumps(job):
                environment = job.get("environment")
                env_name = environment.get("name") if isinstance(environment, dict) else environment
                assert env_name == "oncall", (
                    f"{workflow.name}: job {name} reads GRAFANA_READONLY_TOKEN"
                )
    example = (REPO / ".env.example").read_text()
    assert re.search(r"^# GRAFANA_CLOUD_OTLP_TOKEN=$", example, re.MULTILINE)


# --- verify (make check-stack) ---------------------------------------------------------


def test_concrete_fills_in_grafanas_interval_variables() -> None:
    expr = "rate(x[$__rate_interval]) + increase(y[$__range]) + z[$__interval]"
    assert g._concrete(expr) == "rate(x[1m]) + increase(y[1h]) + z[1m]"


def test_verify_reports_a_missing_dashboard(monkeypatch: pytest.MonkeyPatch) -> None:
    def missing(url: str) -> Any:
        raise RuntimeError("HTTP 404: not found")

    monkeypatch.setattr(g, "_get", missing)
    [problem] = g.verify("http://grafana.invalid")
    assert "is not provisioned" in problem


def test_verify_runs_every_query_and_reports_failures(monkeypatch: pytest.MonkeyPatch) -> None:
    model = g.dashboard("local")
    seen: list[str] = []

    def fake(url: str) -> Any:
        if "/api/dashboards/uid/" in url:
            return {"dashboard": model}
        seen.append(url)
        if "histogram_quantile" in url:
            raise RuntimeError("HTTP 400: bad_data")
        return {"status": "success", "data": {"result": [{"value": [0, "1"]}]}}

    monkeypatch.setattr(g, "_get", fake)
    problems = g.verify("http://grafana.invalid")
    assert len(seen) == len(all_targets(model))
    assert all("/prometheus/" in u or "/loki/" in u or "/tempo/" in u for u in seen)
    assert problems and all("bad_data" in p for p in problems)
    assert not any("$__" in u for u in seen), "interval variables must be filled in"


def test_verify_notices_a_stale_provisioned_dashboard(monkeypatch: pytest.MonkeyPatch) -> None:
    old = g.dashboard("local")
    old["panels"] = old["panels"][:3]

    def fake(url: str) -> Any:
        return {"dashboard": old} if "/api/dashboards/uid/" in url else {"status": "success"}

    monkeypatch.setattr(g, "_get", fake)
    assert any("differs" in p for p in g.verify("http://grafana.invalid"))


def _answers(model: dict[str, Any], empty: Callable[[str], bool]) -> Callable[[str], Any]:
    """A fake Grafana: the dashboard, then every query with one series unless `empty(url)`."""

    def fake(url: str) -> Any:
        if "/api/dashboards/uid/" in url:
            return {"dashboard": model}
        if "/tempo/" in url:
            return {"traces": []}
        return {"status": "success", "data": {"result": [] if empty(url) else [{"v": 1}]}}

    return fake


def test_verify_requires_data_from_every_metrics_query(monkeypatch: pytest.MonkeyPatch) -> None:
    """#33: a query of an unknown metric parses and returns nothing; that must fail."""
    model = g.dashboard("local")
    # Loki's error panels are rightly empty; the history counter's queries return nothing.
    monkeypatch.setattr(
        g, "_get", _answers(model, lambda url: "/loki/" in url or "focus_history_loads" in url)
    )
    problems = g.verify("http://grafana.invalid")
    affected = [
        t
        for t in all_targets(model)
        if t["datasource"]["type"] == "prometheus" and g.HISTORY_LOADS in t["expr"]
    ]
    assert affected
    assert len(problems) == len(affected)
    assert all(g.NO_DATA in p for p in problems)


def test_verify_waits_for_the_next_metric_export(monkeypatch: pytest.MonkeyPatch) -> None:
    model = g.dashboard("local")
    exported = {"yet": False}

    def sleep(seconds: float) -> None:
        exported["yet"] = True

    monkeypatch.setattr(g, "_get", _answers(model, lambda url: not exported["yet"]))
    monkeypatch.setattr("time.sleep", sleep)
    assert g.verify("http://grafana.invalid", wait_s=60) == []
