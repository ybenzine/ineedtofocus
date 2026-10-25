"""User-impact alert rules (#33): the JSON in infra/grafana/alerts/ is current, each rule
group sees only its own environment and only the key journey (never CPU or memory), the
thresholds are the agreed ones, quiet periods never fire, the local stack provisions the
local group, and `verify` / `apply` talk to Grafana as intended. No Grafana: `make
check-stack` runs the rules against the real local stack."""

from __future__ import annotations

import json
import re
from pathlib import Path
from typing import Any

import grafana_alerts as a
import grafana_dashboards as g
import pytest
import yaml  # type: ignore[import-untyped]  # no stubs in the locked env

REPO = Path(__file__).resolve().parents[2]
OBSERVABILITY = (REPO / "_docs" / "observability.md").read_text()
PROM_SELECTOR = re.compile(r"\b([a-z_][a-z0-9_]*)\{([^}]*)\}")
# Only the journey's own metrics (#31): saves and history latency.
JOURNEY_METRICS = {g.SAVES, f"{g.HISTORY_DURATION}_bucket"}
RESOURCE_WORDS = re.compile(r"cpu|memory|mem_|heap|disk|filesystem|process_|container_|node_")


def all_queries(env: str) -> list[dict[str, Any]]:
    return [q for rule in a.rules(env) for q in rule["data"]]


def test_committed_json_is_what_the_script_generates() -> None:
    assert a.stale() == [], "run python3 scripts/grafana_alerts.py and commit the result"


@pytest.mark.parametrize("env", a.ENVIRONMENTS)
def test_committed_json_parses_to_the_model(env: str) -> None:
    assert json.loads(a.path(env).read_text()) == a.provisioning(env)


@pytest.mark.parametrize("env", a.ENVIRONMENTS)
def test_two_rules_on_the_key_journey_only(env: str) -> None:
    rules = a.rules(env)
    assert [r["labels"]["alert"] for r in rules] == ["session-save-errors", "history-latency"]
    for _, expr in a.queries(env):
        metrics = {m for m, _ in PROM_SELECTOR.findall(expr)}
        assert metrics and metrics <= JOURNEY_METRICS, expr
    text = json.dumps(a.provisioning(env)).lower()
    assert not RESOURCE_WORDS.search(text), "no alert on CPU, memory or other resources"


@pytest.mark.parametrize("env", a.ENVIRONMENTS)
def test_every_query_filters_on_its_own_environment(env: str) -> None:
    for _, expr in a.queries(env):
        for metric, labels in PROM_SELECTOR.findall(expr):
            assert f'deployment_environment_name="{env}"' in labels, (metric, expr)
            assert f'service_name="{g.SERVICE}"' in labels, (metric, expr)
    other = {"prod": "dev", "dev": "prod", "local": "prod"}[env]
    assert f'"{other}"' not in json.dumps([e for _, e in a.queries(env)])
    for rule in a.rules(env):
        assert rule["labels"]["environment"] == env
        assert rule["uid"].endswith(f"-{env}") and len(rule["uid"]) <= 40


def test_thresholds_are_the_agreed_ones() -> None:
    """tech_stack.md §4: save error rate > 5% over 5 min with a minimum count; history
    p95 > 2 s over 5 min. The dashboards draw the same lines."""
    assert a.SAVE_ERROR_RATE_LIMIT == pytest.approx(1 - g.SAVE_SUCCESS_TARGET) == 0.05
    # 2 s is a bucket edge of the latency histogram (backend tests), so p95 > 2 is exact.
    assert a.HISTORY_P95_LIMIT_S == g.HISTORY_P95_LIMIT_S == 2
    assert a.SAVE_MIN_SESSIONS == 10
    save, history = a.rules("prod")
    assert save["data"][2]["model"]["expression"] == "$A > 0.05 && $B >= 10"
    assert history["data"][1]["model"]["expression"] == "$A > 2"
    for rule in (save, history):
        assert rule["condition"] == "C"
        for query in rule["data"]:
            if query["datasourceUid"] != a.EXPR["uid"]:
                assert "[5m]" in query["model"]["expr"]
                assert query["model"]["instant"] is True


def test_save_error_rate_is_the_dashboards_definition() -> None:
    """outcome="error" over every session submitted: rejected sessions don't count."""
    expr = a.save_error_rate("prod")
    assert f'{g.SAVES}{{{g._sel("prod")[1:-1]}, outcome="error"}}' in expr
    assert a.sessions_submitted("prod") in expr
    assert 'outcome="rejected"' not in expr
    dashboard_numerator = g._error_rate(g.SAVES, "prod", "5m").split(" / ")[0]
    assert expr.startswith(dashboard_numerator)


def test_quiet_periods_are_no_data_never_nan() -> None:
    """The journey counters exist from startup at 0, so a window without traffic is 0/0 or
    a quantile of nothing (NaN), which Grafana would take as firing. The `> 0` filters make
    it no data instead, and no data is OK."""
    assert a.save_error_rate("prod").endswith(f"/ ({a.sessions_submitted('prod')} > 0)")
    assert a.history_p95("prod").endswith(" > 0")
    for rule in a.rules("prod"):
        assert rule["noDataState"] == "OK"
        assert rule["execErrState"] == "KeepLast"  # a broken query isn't user impact
        assert rule["for"] == "1m"


@pytest.mark.parametrize("env", a.ENVIRONMENTS)
def test_annotations_link_the_runbook_and_the_dashboard_panel(env: str) -> None:
    panels = {str(p["id"]): p["title"] for p in g.dashboard(env)["panels"]}
    for rule in a.rules(env):
        notes = rule["annotations"]
        assert notes["__dashboardUid__"] == g.uid(env)
        assert notes["__panelId__"] in panels
        assert notes["runbook_url"].endswith(f"/_docs/runbooks/{rule['labels']['alert']}.md")
        assert "$values.A" in notes["description"]


def test_data_sources() -> None:
    for env in a.DEPLOYED:
        assert {q["datasourceUid"] for q in all_queries(env)} == {"grafanacloud-prom", "__expr__"}
    assert {q["datasourceUid"] for q in all_queries("local")} == {"prometheus", "__expr__"}


def test_api_group_is_the_same_rules_in_the_api_shape() -> None:
    group = a.api_group("prod", "folder-1")
    assert group["title"] == "key-journey-prod" and group["interval"] == 60
    assert group["folderUid"] == "folder-1"
    for rule, model in zip(group["rules"], a.rules("prod"), strict=True):
        assert rule["folderUID"] == "folder-1" and rule["ruleGroup"] == "key-journey-prod"
        assert rule["data"] == model["data"]
    other = a.api_group("prod", "folder-1", datasource="my-prom")
    uids = {q["datasourceUid"] for r in other["rules"] for q in r["data"]}
    assert uids == {"my-prom", "__expr__"}
    models = [q["model"]["datasource"]["uid"] for r in other["rules"] for q in r["data"]]
    assert set(models) == {"my-prom", "__expr__"}


def test_local_stack_provisions_the_local_group() -> None:
    compose = yaml.safe_load((REPO / "compose.yaml").read_text())
    volumes = compose["services"]["lgtm"]["volumes"]
    assert (
        "./infra/grafana/alerts/key-journey-local.json:"
        "/otel-lgtm/grafana/conf/provisioning/alerting/focus-alerts.json:ro"
    ) in volumes


def test_documented() -> None:
    assert "scripts/grafana_alerts.py" in OBSERVABILITY
    for rule in a.rules("prod"):
        assert rule["title"].removesuffix(" (prod)") in OBSERVABILITY
    assert "FAULT_SAVE_ERROR_PERCENT" in OBSERVABILITY
    assert "scripts/traffic.py" in OBSERVABILITY


# --- verify and wait (the local stack) ---------------------------------------------------


def _grafana(states: list[dict[str, Any]], empty: bool = False) -> Any:
    def fake(url: str) -> Any:
        if "/api/prometheus/grafana/api/v1/rules" in url:
            return {"data": {"groups": [{"name": "key-journey-local", "rules": states}]}}
        assert "/prometheus/api/v1/query" in url
        return {"status": "success", "data": {"result": [] if empty else [{"value": [0, "1"]}]}}

    return fake


HEALTHY = [
    {"name": "Session saves failing (local)", "labels": {"alert": "session-save-errors"},
     "health": "ok", "state": "inactive"},
    {"name": "History slow (local)", "labels": {"alert": "history-latency"},
     "health": "ok", "state": "inactive"},
]  # fmt: skip


def test_verify_passes_on_healthy_rules_with_data(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(g, "_get", _grafana(HEALTHY))
    assert a.verify("http://grafana.invalid") == []


def test_verify_needs_data_from_every_query(monkeypatch: pytest.MonkeyPatch) -> None:
    """A renamed metric parses fine and returns nothing: the rule would never fire."""
    monkeypatch.setattr(g, "_get", _grafana(HEALTHY, empty=True))
    problems = a.verify("http://grafana.invalid")
    assert len(problems) == len(a.queries("local")) == 3
    assert all(g.NO_DATA in p for p in problems)


def test_verify_reports_missing_and_broken_rules(monkeypatch: pytest.MonkeyPatch) -> None:
    broken = [{**HEALTHY[0], "health": "error", "lastError": "bad query"}]
    monkeypatch.setattr(g, "_get", _grafana(broken))
    problems = a.verify("http://grafana.invalid")
    assert any("session-save-errors fails to evaluate: bad query" in p for p in problems)
    assert any("history-latency is not provisioned" in p for p in problems)


def test_wait_returns_once_the_rule_is_in_the_state(monkeypatch: pytest.MonkeyPatch) -> None:
    states = iter(["inactive", "pending", "firing"])

    def fake(url: str) -> Any:
        rule = {**HEALTHY[0], "state": next(states)}
        return {"data": {"groups": [{"name": "key-journey-local", "rules": [rule]}]}}

    monkeypatch.setattr(g, "_get", fake)
    monkeypatch.setattr("time.sleep", lambda s: None)
    assert a.wait("http://grafana.invalid", "session-save-errors", "firing", 1)
    assert a.normalised("Inactive") == "normal" and a.normalised("Firing") == "firing"


# --- apply (Grafana Cloud, Yacine) -----------------------------------------------------


BUILT_IN = {"uid": "grafanacloud-prom", "type": "prometheus", "name": "grafanacloud-focus-prom"}


def _cloud(
    calls: list[tuple[str, str, Any]],
    folders: list[dict[str, str]],
    sources: list[dict[str, str]],
) -> Any:
    def call(grafana: str, token: str, method: str, api: str, body: Any = None) -> Any:
        assert token == "tok"
        calls.append((method, api, body))
        if api.startswith("/api/folders"):
            return folders if method == "GET" else {"uid": a.FOLDER_UID}
        if api == "/api/datasources":
            return sources
        return {}

    return call


def test_apply_puts_the_group_into_the_existing_folder(monkeypatch: pytest.MonkeyPatch) -> None:
    calls: list[tuple[str, str, Any]] = []
    folders = [{"uid": "abc", "title": "I Need To Focus"}]
    monkeypatch.setattr(a, "_call", _cloud(calls, folders, [BUILT_IN]))
    a.apply("https://example.grafana.net", "dev", "tok")
    assert [(m, p) for m, p, _ in calls] == [
        ("GET", "/api/folders?limit=1000"),
        ("GET", "/api/datasources"),
        ("PUT", "/api/v1/provisioning/folder/abc/rule-groups/key-journey-dev"),
    ]
    assert calls[2][2] == a.api_group("dev", "abc")


def test_apply_creates_the_folder_when_missing(monkeypatch: pytest.MonkeyPatch) -> None:
    calls: list[tuple[str, str, Any]] = []
    folders = [{"uid": "x", "title": "Other"}]
    monkeypatch.setattr(a, "_call", _cloud(calls, folders, [BUILT_IN]))
    a.apply("https://example.grafana.net", "prod", "tok")
    assert [(m, p) for m, p, _ in calls][1] == ("POST", "/api/folders")
    put = f"/api/v1/provisioning/folder/{a.FOLDER_UID}/rule-groups/key-journey-prod"
    assert [(m, p) for m, p, _ in calls][-1] == ("PUT", put)


def test_apply_finds_the_stacks_prometheus_when_the_built_in_uid_is_absent(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    calls: list[tuple[str, str, Any]] = []
    folders = [{"uid": "abc", "title": "I Need To Focus"}]
    own = {"uid": "p1", "type": "prometheus", "name": "grafanacloud-ineedtofocus-prom"}
    loki = {"uid": "l1", "type": "loki", "name": "grafanacloud-ineedtofocus-logs"}
    monkeypatch.setattr(a, "_call", _cloud(calls, folders, [own, loki]))
    a.apply("https://example.grafana.net", "prod", "tok")
    assert calls[-1][2] == a.api_group("prod", "abc", datasource="p1")

    two = [own, {**own, "uid": "p2", "name": "grafanacloud-other-prom"}]
    monkeypatch.setattr(a, "_call", _cloud([], folders, two))
    with pytest.raises(RuntimeError, match="--datasource"):
        a.apply("https://example.grafana.net", "prod", "tok")


def test_apply_only_for_deployed_environments_and_never_echoes_the_token(
    monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
) -> None:
    monkeypatch.setattr("getpass.getpass", lambda prompt: "secret-token-value")
    monkeypatch.setattr(a, "apply", lambda *args: print("applied"))
    assert a.main(["apply", "local", "--grafana", "https://x.grafana.net"]) == 2
    assert a.main(["apply", "prod"]) == 2  # --grafana is required
    assert a.main(["apply", "prod", "--grafana", "https://x.grafana.net"]) == 0
    out = capsys.readouterr()
    assert "secret-token-value" not in out.out + out.err
