#!/usr/bin/env python3
"""Key-journey Grafana dashboards (#32): one per environment, generated from this file.

    python3 scripts/grafana_dashboards.py           # write infra/grafana/dashboards/*.json
    python3 scripts/grafana_dashboards.py --check   # fail if those files are out of date
    python3 scripts/grafana_dashboards.py verify [<grafana url>]
                                  # run every query of the local dashboard against the
                                  # local stack's Grafana (`make up`; default: GRAFANA_PORT);
                                  # each metrics query must return data (after journey
                                  # traffic, which `make check-stack` sends)

The JSON files are what Grafana Cloud imports (prod, dev) and what the local stack
provisions (local, compose.yaml). Edit this file, never the JSON: `make test-scripts`
fails when they differ. The metric names are the contract in _docs/observability.md
("Metrics"), which the backend's instrumentation (#31) emits.

Each dashboard filters on its own environment (`deployment.environment.name`, set by the
collector on prod and dev, and by compose.yaml locally) and picks its data sources
through three variables, so the same model works in Grafana Cloud (`grafanacloud-*`
data sources) and in the local grafana/otel-lgtm (`prometheus`, `loki`, `tempo`).
Stdlib only.
"""

from __future__ import annotations

import json
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from collections.abc import Iterator
from pathlib import Path
from typing import Any

REPO = Path(__file__).resolve().parents[1]
OUT_DIR = REPO / "infra" / "grafana" / "dashboards"
SERVICE = "ineedtofocus"
ENVIRONMENTS = ("prod", "dev", "local")
# Data source UIDs: Grafana Cloud's built-in ones, and grafana/otel-lgtm's.
DATASOURCES = {
    "cloud": {
        "metrics": "grafanacloud-prom",
        "logs": "grafanacloud-logs",
        "traces": "grafanacloud-traces",
    },
    "local": {"metrics": "prometheus", "logs": "loki", "traces": "tempo"},
}
DS_TYPES = {"metrics": "prometheus", "logs": "loki", "traces": "tempo"}
DS_LABELS = {"metrics": "Metrics", "logs": "Logs", "traces": "Traces"}
METRICS = {"type": "prometheus", "uid": "${metrics}"}
LOGS = {"type": "loki", "uid": "${logs}"}
TRACES = {"type": "tempo", "uid": "${traces}"}

# The journey's metrics (_docs/observability.md: "Signals" for the OpenTelemetry names
# backend/app/metrics.py emits, #31; "Dashboards" for these Prometheus names).
SAVES = "focus_session_saves_total"  # focus.session.saves {session}: kind, outcome
SAVE_DURATION = (
    "focus_session_save_duration_seconds"  # focus.session.save.duration s: kind, outcome
)
SYNC_BATCH = "focus_sync_batch_size"  # focus.sync.batch.size {session}
HISTORY_LOADS = "focus_history_loads_total"  # focus.history.loads {load}: outcome
HISTORY_DURATION = "focus_history_load_duration_seconds"  # focus.history.load.duration s: outcome
HTTP_DURATION = "http_server_request_duration_seconds"
JOURNEY_ROUTES = "/api/sessions|/api/sessions/sync|/api/history"
# Alert thresholds (_docs/observability.md, "Alerts"), drawn on the panels.
SAVE_SUCCESS_TARGET = 0.95
HISTORY_P95_LIMIT_S = 2
ERROR_SEVERITY = 17  # OpenTelemetry severity number of ERROR (CRITICAL is 21)


def uid(env: str) -> str:
    return f"focus-key-journey-{env}"


def title(env: str) -> str:
    return f"I Need To Focus: key journey ({env})"


def _sel(env: str, extra: str = "") -> str:
    labels = f'service_name="{SERVICE}", deployment_environment_name="{env}"'
    return "{" + labels + (f", {extra}" if extra else "") + "}"


def _logs(env: str) -> str:
    return (
        f'{{service_name="{SERVICE}"}} | deployment_environment_name="{env}"'
        f" | severity_number >= {ERROR_SEVERITY}"
    )


def _traceql(env: str, extra: str) -> str:
    return (
        f'{{resource.service.name="{SERVICE}" && resource.deployment.environment.name="{env}"'
        f" && kind=server && {extra}}}"
    )


def _error_rate(counter: str, env: str, window: str) -> str:
    """Share of `counter` with outcome=error; 0 (not "no data") while nothing failed."""
    failed = _sel(env, 'outcome="error"')
    errors = f"sum(increase({counter}{failed}[{window}]))"
    return f"(({errors}) or vector(0)) / sum(increase({counter}{_sel(env)}[{window}]))"


def _success_rate(counter: str, env: str, window: str) -> str:
    return f"1 - ({_error_rate(counter, env, window)})"


def _prom(expr: str, legend: str, ref: str = "A", *, instant: bool = False) -> dict[str, Any]:
    target: dict[str, Any] = {"refId": ref, "datasource": METRICS, "expr": expr}
    if instant:
        target.update(instant=True, range=False)
    else:
        # Exemplars (a dot per sampled request, linking to its trace) only make sense on a
        # latency axis; on a rate or ratio panel they'd plot a raw count.
        latency = "histogram_quantile" in expr and "_duration_seconds_bucket" in expr
        target.update(range=True, legendFormat=legend, exemplar=latency)
    return target


def _thresholds(*steps: tuple[float | None, str]) -> dict[str, Any]:
    return {"mode": "absolute", "steps": [{"color": c, "value": v} for v, c in steps]}


class Layout:
    """Places panels left to right on Grafana's 24-column grid and numbers them."""

    def __init__(self) -> None:
        self.panels: list[dict[str, Any]] = []
        self.x = 0
        self.y = 0
        self.row_height = 0

    def row(self, title: str) -> None:
        self._newline()
        self._add({"type": "row", "title": title, "collapsed": False, "panels": []}, 24, 1)
        self._newline()

    def add(self, panel: dict[str, Any], w: int, h: int) -> None:
        if self.x + w > 24:
            self._newline()
        self._add(panel, w, h)

    def _add(self, panel: dict[str, Any], w: int, h: int) -> None:
        panel["id"] = len(self.panels) + 1
        panel["gridPos"] = {"h": h, "w": w, "x": self.x, "y": self.y}
        self.panels.append(panel)
        self.x += w
        self.row_height = max(self.row_height, h)

    def _newline(self) -> None:
        if self.x:
            self.y += self.row_height
        self.x = 0
        self.row_height = 0


def stat(
    title: str, description: str, target: dict[str, Any], unit: str, thresholds: dict[str, Any]
) -> dict[str, Any]:
    return {
        "type": "stat",
        "title": title,
        "description": description,
        "datasource": METRICS,
        "targets": [target],
        "fieldConfig": {
            "defaults": {
                "unit": unit,
                "decimals": 2,
                "noValue": "no data yet",
                "thresholds": thresholds,
                "color": {"mode": "thresholds"},
            },
            "overrides": [],
        },
        "options": {
            "reduceOptions": {"calcs": ["lastNotNull"], "fields": "", "values": False},
            "colorMode": "value",
            "graphMode": "none",
            "textMode": "value",
        },
    }


def timeseries(
    title: str,
    description: str,
    targets: list[dict[str, Any]],
    unit: str,
    *,
    threshold: tuple[float, str] | None = None,
    stacked: bool = False,
    minimum: float | None = 0,
    maximum: float | None = None,
) -> dict[str, Any]:
    custom: dict[str, Any] = {
        "lineWidth": 2,
        "fillOpacity": 25 if stacked else 0,
        "showPoints": "never",
    }
    defaults: dict[str, Any] = {"unit": unit, "custom": custom}
    if stacked:
        custom["stacking"] = {"mode": "normal", "group": "A"}
    if threshold is not None:
        value, color = threshold
        custom["thresholdsStyle"] = {"mode": "dashed"}
        defaults["thresholds"] = _thresholds((None, "transparent"), (value, color))
    if minimum is not None:
        defaults["min"] = minimum
    if maximum is not None:
        defaults["max"] = maximum
    return {
        "type": "timeseries",
        "title": title,
        "description": description,
        "datasource": METRICS,
        "targets": targets,
        "fieldConfig": {"defaults": defaults, "overrides": []},
        "options": {
            "legend": {"displayMode": "list", "placement": "bottom", "showLegend": True},
            "tooltip": {"mode": "multi", "sort": "desc"},
        },
    }


def traces_table(title: str, description: str, query: str) -> dict[str, Any]:
    return {
        "type": "table",
        "title": title,
        "description": description,
        "datasource": TRACES,
        "targets": [
            {
                "refId": "A",
                "datasource": TRACES,
                "queryType": "traceql",
                "query": query,
                "limit": 20,
                "tableType": "traces",
            }
        ],
        "fieldConfig": {"defaults": {}, "overrides": []},
        "options": {"showHeader": True, "sortBy": [{"displayName": "Start time", "desc": True}]},
    }


def explore_trace_url(env_ds: str) -> str:
    """An Explore link that opens the trace whose ID is in the clicked row's `trace_id`."""
    pane = {
        "datasource": env_ds,
        "queries": [
            {
                "refId": "A",
                "datasource": {"type": "tempo", "uid": env_ds},
                "queryType": "traceql",
                "query": "${__data.fields.trace_id}",
            }
        ],
        "range": {"from": "now-1h", "to": "now"},
    }
    panes = json.dumps({"trace": pane}, separators=(",", ":"))
    return "/explore?schemaVersion=1&panes=" + panes


def dashboard(env: str) -> dict[str, Any]:
    ds = DATASOURCES["local" if env == "local" else "cloud"]
    rate = "$__rate_interval"
    layout = Layout()

    # --- Session saves ---------------------------------------------------------
    layout.row("Session saves (single and offline sync)")
    layout.add(
        stat(
            "Save success rate (time range)",
            "Sessions not lost to a server error: 1 - outcome=error / all sessions submitted, "
            "single saves and sync batches together (rejected, invalid input, counts as handled). "
            f"Below 95% over 5 minutes is the alert. Metric `{SAVES}` (#31).",
            _prom(_success_rate(SAVES, env, "$__range"), "", instant=True),
            "percentunit",
            _thresholds((None, "red"), (SAVE_SUCCESS_TARGET, "green")),
        ),
        6,
        7,
    )
    layout.add(
        timeseries(
            "Save success rate (5 min windows, as the alert sees it)",
            "The same ratio over sliding 5-minute windows. The dashed line is the alert threshold.",
            [_prom(_success_rate(SAVES, env, "5m"), "success rate")],
            "percentunit",
            threshold=(SAVE_SUCCESS_TARGET, "red"),
            minimum=None,
            maximum=1,
        ),
        18,
        7,
    )
    layout.add(
        timeseries(
            "Sessions saved per minute, by outcome",
            "created: new; existing: a retry of one already saved (idempotent); rejected: an "
            "invalid session or an id conflict (the client's problem); error: the server failed.",
            [_prom(f"sum by (outcome) (rate({SAVES}{_sel(env)}[{rate}])) * 60", "{{outcome}}")],
            "short",
            stacked=True,
        ),
        12,
        8,
    )
    layout.add(
        timeseries(
            "Save latency (per request)",
            "kind single: POST /api/sessions; kind sync: POST /api/sessions/sync (up to 100 "
            "sessions). Dots are exemplars: click one to open its trace.",
            [
                _prom(
                    f"histogram_quantile({q}, sum by (le, kind) "
                    f"(rate({SAVE_DURATION}_bucket{_sel(env)}[{rate}])))",
                    f"p{int(q * 100)} {{{{kind}}}}",
                    ref,
                )
                for q, ref in ((0.5, "A"), (0.95, "B"), (0.99, "C"))
            ],
            "s",
        ),
        12,
        8,
    )
    layout.add(
        timeseries(
            "Offline sync batch size",
            f"Sessions per POST /api/sessions/sync request. Metric `{SYNC_BATCH}` (#31).",
            [
                _prom(
                    f"histogram_quantile({q}, sum by (le) "
                    f"(rate({SYNC_BATCH}_bucket{_sel(env)}[{rate}])))",
                    f"p{int(q * 100)}",
                    ref,
                )
                for q, ref in ((0.5, "A"), (0.95, "B"))
            ],
            "short",
        ),
        12,
        7,
    )
    layout.add(
        timeseries(
            "Save requests per minute, by kind and outcome",
            "ok: saved (a sync batch may still hold rejected items); client_error: 4xx; "
            "error: an unexpected failure (5xx).",
            [
                _prom(
                    f"sum by (kind, outcome) (rate({SAVE_DURATION}_count{_sel(env)}[{rate}])) * 60",
                    "{{kind}} {{outcome}}",
                )
            ],
            "short",
            stacked=True,
        ),
        12,
        7,
    )

    # --- History loads ---------------------------------------------------------
    layout.row("History loads")
    layout.add(
        stat(
            "History p95 latency (time range)",
            "95th percentile of GET /api/history over the time range. "
            f"Over {HISTORY_P95_LIMIT_S} s "
            f"over 5 minutes is the alert. Metric `{HISTORY_DURATION}` (#31).",
            _prom(
                f"histogram_quantile(0.95, sum by (le) "
                f"(increase({HISTORY_DURATION}_bucket{_sel(env)}[$__range])))",
                "",
                instant=True,
            ),
            "s",
            _thresholds((None, "green"), (HISTORY_P95_LIMIT_S, "red")),
        ),
        6,
        8,
    )
    layout.add(
        timeseries(
            "History latency",
            "p50, p95 and p99 of GET /api/history. The dashed line is the alert threshold; "
            "dots are exemplars that open their trace.",
            [
                _prom(
                    f"histogram_quantile({q}, sum by (le) "
                    f"(rate({HISTORY_DURATION}_bucket{_sel(env)}[{rate}])))",
                    f"p{int(q * 100)}",
                    ref,
                )
                for q, ref in ((0.5, "A"), (0.95, "B"), (0.99, "C"))
            ],
            "s",
            threshold=(HISTORY_P95_LIMIT_S, "red"),
        ),
        18,
        8,
    )
    layout.add(
        timeseries(
            "History loads per minute, by outcome",
            "ok; invalid: a bad view, date or time zone (4xx); error: a server failure. "
            f"Metric `{HISTORY_LOADS}` (#31).",
            [
                _prom(
                    f"sum by (outcome) (rate({HISTORY_LOADS}{_sel(env)}[{rate}])) * 60",
                    "{{outcome}}",
                )
            ],
            "short",
            stacked=True,
        ),
        12,
        7,
    )
    layout.add(
        timeseries(
            "History error rate (5 min windows)",
            "History loads that failed on the server (outcome=error) out of all loads.",
            [_prom(_error_rate(HISTORY_LOADS, env, "5m"), "error rate")],
            "percentunit",
            threshold=(1 - SAVE_SUCCESS_TARGET, "red"),
            maximum=1,
        ),
        12,
        7,
    )

    # --- Errors and traces -----------------------------------------------------
    layout.row("Errors, logs and traces")
    layout.add(
        {
            "type": "logs",
            "title": "Error logs",
            "description": "App log lines at ERROR or above (JSON logs over OTLP). Expand a "
            "line for its trace_id; the table beside it links each one to its trace.",
            "datasource": LOGS,
            "targets": [
                {"refId": "A", "datasource": LOGS, "expr": _logs(env), "queryType": "range"}
            ],
            "options": {
                "showTime": True,
                "wrapLogMessage": True,
                "sortOrder": "Descending",
                "enableLogDetails": True,
                "dedupStrategy": "none",
            },
        },
        12,
        10,
    )
    layout.add(
        {
            "type": "table",
            "title": "Error logs with their traces",
            "description": "The same lines; click a trace_id to open the trace in Explore.",
            "datasource": LOGS,
            "targets": [
                {"refId": "A", "datasource": LOGS, "expr": _logs(env), "queryType": "range"}
            ],
            "transformations": [
                {
                    "id": "extractFields",
                    "options": {"source": "labels", "format": "auto", "replace": False},
                },
                {
                    "id": "organize",
                    "options": {
                        "includeByName": {
                            "Time": True,
                            "trace_id": True,
                            "scope_name": True,
                            "Line": True,
                        },
                        "indexByName": {"Time": 0, "trace_id": 1, "scope_name": 2, "Line": 3},
                        "renameByName": {"scope_name": "logger", "Line": "message"},
                    },
                },
            ],
            "fieldConfig": {
                "defaults": {},
                "overrides": [
                    {
                        "matcher": {"id": "byName", "options": "trace_id"},
                        "properties": [
                            {
                                "id": "links",
                                "value": [
                                    {"title": "Open trace", "url": explore_trace_url("${traces}")}
                                ],
                            },
                            {"id": "custom.width", "value": 280},
                        ],
                    },
                    {
                        "matcher": {"id": "byName", "options": "Time"},
                        "properties": [{"id": "custom.width", "value": 170}],
                    },
                ],
            },
            "options": {"showHeader": True, "sortBy": [{"displayName": "Time", "desc": True}]},
        },
        12,
        10,
    )
    layout.add(
        timeseries(
            "Error log lines per minute, by logger",
            "",
            [
                {
                    "refId": "A",
                    "datasource": LOGS,
                    "expr": f"sum by (scope_name) (count_over_time({_logs(env)} [1m]))",
                    "legendFormat": "{{scope_name}}",
                    "queryType": "range",
                }
            ],
            "short",
            stacked=True,
        )
        | {"datasource": LOGS},
        8,
        8,
    )
    layout.add(
        traces_table(
            "Failed requests (traces)",
            "Server spans with an error status, newest first. Click a trace ID to open it.",
            _traceql(env, "status=error"),
        ),
        8,
        8,
    )
    layout.add(
        traces_table(
            "Slow key-journey requests (over 1 s)",
            "Session saves and history loads that took over a second.",
            _traceql(env, f'span.http.route=~"{JOURNEY_ROUTES}" && duration > 1s'),
        ),
        8,
        8,
    )

    # --- HTTP (all routes) -----------------------------------------------------
    layout.row("HTTP, every API route (FastAPI's standard request metric)")
    journey = f'http_route=~"{JOURNEY_ROUTES}"'
    api_routes = _sel(env, 'http_route=~"/api/.*"')
    layout.add(
        timeseries(
            "Requests per minute, by route",
            f"Metric `{HTTP_DURATION}` (OpenTelemetry HTTP semantic conventions).",
            [
                _prom(
                    f"sum by (http_route) (rate({HTTP_DURATION}_count{api_routes}[{rate}])) * 60",
                    "{{http_route}}",
                )
            ],
            "short",
            stacked=True,
        ),
        8,
        8,
    )
    errors_5xx = _sel(env, f'{journey}, http_response_status_code=~"5.."')
    all_journey = _sel(env, journey)
    layout.add(
        timeseries(
            "5xx ratio, key-journey routes",
            "Share of requests answered with a 5xx, per route, over 5 minutes.",
            [
                _prom(
                    f"(sum by (http_route) (rate({HTTP_DURATION}_count{errors_5xx}[5m])) "
                    f"or sum by (http_route) (rate({HTTP_DURATION}_count{all_journey}[5m])) * 0) "
                    f"/ sum by (http_route) (rate({HTTP_DURATION}_count{all_journey}[5m]))",
                    "{{http_route}}",
                )
            ],
            "percentunit",
            threshold=(1 - SAVE_SUCCESS_TARGET, "red"),
            maximum=1,
        ),
        8,
        8,
    )
    layout.add(
        timeseries(
            "p95 latency, key-journey routes",
            "",
            [
                _prom(
                    f"histogram_quantile(0.95, sum by (le, http_route) "
                    f"(rate({HTTP_DURATION}_bucket{all_journey}[{rate}])))",
                    "{{http_route}}",
                )
            ],
            "s",
            threshold=(HISTORY_P95_LIMIT_S, "red"),
        ),
        8,
        8,
    )

    others = [e for e in ENVIRONMENTS if e != env and (e == "local") == (env == "local")]
    return {
        "uid": uid(env),
        "title": title(env),
        "description": f"Save a finished session and load history, {env} environment (#32). "
        "Generated by scripts/grafana_dashboards.py: change it there, not in the UI.",
        "tags": ["ineedtofocus", "key-journey", env],
        "timezone": "browser",
        "editable": True,
        "graphTooltip": 1,
        "schemaVersion": 39,
        "version": 1,
        "refresh": "1m",
        "time": {"from": "now-6h", "to": "now"},
        "templating": {
            "list": [
                {
                    "name": name,
                    "label": DS_LABELS[name],
                    "type": "datasource",
                    "query": DS_TYPES[name],
                    "current": {"text": ds[name], "value": ds[name]},
                    "hide": 0,
                    "refresh": 1,
                    "regex": "",
                    "options": [],
                }
                for name in ("metrics", "logs", "traces")
            ]
        },
        "annotations": {"list": []},
        "links": [
            {"title": title(other), "type": "link", "url": f"/d/{uid(other)}", "targetBlank": False}
            for other in others
        ],
        "panels": layout.panels,
    }


def render(env: str) -> str:
    return json.dumps(dashboard(env), indent=2, sort_keys=False) + "\n"


def path(env: str) -> Path:
    return OUT_DIR / f"key-journey-{env}.json"


def write() -> None:
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    for env in ENVIRONMENTS:
        path(env).write_text(render(env))
        print(f"wrote {path(env).relative_to(REPO)}")


def stale() -> list[str]:
    """The dashboard files that differ from what this script generates."""
    return [
        str(path(env).relative_to(REPO))
        for env in ENVIRONMENTS
        if not path(env).is_file() or path(env).read_text() != render(env)
    ]


# --- verify: run every query of the local dashboard against the local stack ----------


def targets(model: dict[str, Any]) -> Iterator[tuple[str, dict[str, Any]]]:
    for panel in model["panels"]:
        for target in panel.get("targets", []):
            yield panel["title"], target


def _concrete(expr: str) -> str:
    """Grafana's interval variables, as Grafana would fill them in for a 1-hour range."""
    return (
        expr.replace("$__rate_interval", "1m")
        .replace("$__range", "1h")
        .replace("$__interval", "1m")
    )


def _get(url: str) -> Any:
    try:
        with urllib.request.urlopen(url, timeout=20) as r:
            return json.load(r)
    except urllib.error.HTTPError as e:
        raise RuntimeError(f"HTTP {e.code}: {e.read().decode()[:300]}") from None


def run_query(grafana: str, target: dict[str, Any]) -> list[Any]:
    """The query's result: Prometheus series, Loki streams or Tempo traces (maybe none).
    Raises RuntimeError when the backend refuses the query (bad syntax, unknown function)."""
    proxy = f"{grafana}/api/datasources/proxy/uid"
    now = int(time.time())
    kind = target["datasource"]["type"]
    if kind == "prometheus":
        params = {"query": _concrete(target["expr"]), "time": str(now)}
        result = _get(f"{proxy}/prometheus/api/v1/query?{urllib.parse.urlencode(params)}")
        if result.get("status") != "success":
            raise RuntimeError(str(result)[:300])
        return list((result.get("data") or {}).get("result") or [])
    if kind == "loki":
        params = {
            "query": _concrete(target["expr"]),
            "start": str((now - 3600) * 10**9),
            "end": str(now * 10**9),
            "limit": "5",
        }
        result = _get(f"{proxy}/loki/loki/api/v1/query_range?{urllib.parse.urlencode(params)}")
        if result.get("status") != "success":
            raise RuntimeError(str(result)[:300])
        return list((result.get("data") or {}).get("result") or [])
    if kind == "tempo":
        params = {"q": target["query"], "start": str(now - 3600), "end": str(now), "limit": "5"}
        found = _get(f"{proxy}/tempo/api/search?{urllib.parse.urlencode(params)}")
        return list((found or {}).get("traces") or [])
    raise RuntimeError(f"unknown data source type {kind}")


NO_DATA = "returns no data"


def verify(grafana: str, wait_s: float = 0) -> list[str]:
    """Problems with the local dashboard in the running local Grafana (empty: none).

    Every Prometheus query must return at least one series, not merely parse: a renamed
    metric or label returns nothing and would blank a panel silently. `make check-stack`
    sends a save and a history load first, so each one has data (the journey counters'
    series exist from startup, #33). Loki and Tempo queries only have to run: the error
    panels are rightly empty while nothing fails. Retries "no data" for up to `wait_s`
    seconds, for the next metric export to arrive."""
    try:
        found = _get(f"{grafana}/api/dashboards/uid/{uid('local')}")["dashboard"]
    except (RuntimeError, OSError) as e:
        return [f"dashboard {uid('local')} is not provisioned in {grafana}: {e}"]
    expected = dashboard("local")
    deadline = time.monotonic() + wait_s
    while True:
        problems: list[str] = []
        if [p["title"] for p in found["panels"]] != [p["title"] for p in expected["panels"]]:
            problems.append(
                "the provisioned dashboard differs from the generated one (restart lgtm)"
            )
        for panel_title, target in targets(expected):
            where = f"{panel_title} [{target['refId']}]"
            try:
                result = run_query(grafana, target)
            except (RuntimeError, OSError) as e:
                problems.append(f"{where}: {e}")
                continue
            if target["datasource"]["type"] == "prometheus" and not result:
                problems.append(f"{where}: {NO_DATA} (unknown metric or label?)")
        if not any(NO_DATA in p for p in problems) or time.monotonic() > deadline:
            return problems
        time.sleep(5)


def main(argv: list[str]) -> int:
    if argv[:1] == ["--check"]:
        out_of_date = stale()
        if out_of_date:
            print(
                f"FAIL  out of date: {', '.join(out_of_date)}. "
                "Run python3 scripts/grafana_dashboards.py",
                file=sys.stderr,
            )
            return 1
        print("ok    dashboards are up to date")
        return 0
    if argv[:1] == ["verify"]:
        from check_local_stack import GRAFANA

        grafana = argv[1] if len(argv) > 1 else GRAFANA
        problems = verify(grafana, wait_s=60)
        for problem in problems:
            print(f"FAIL  {problem}", file=sys.stderr)
        if problems:
            return 1
        print(
            f"ok    {uid('local')} is provisioned and its "
            f"{sum(1 for _ in targets(dashboard('local')))} queries run (metrics with data)"
        )
        return 0
    if argv:
        print(__doc__, file=sys.stderr)
        return 2
    write()
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
