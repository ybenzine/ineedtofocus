#!/usr/bin/env python3
"""User-impact alert rules (#33): one rule group per environment, generated from this file.

    python3 scripts/grafana_alerts.py            # write infra/grafana/alerts/*.json
    python3 scripts/grafana_alerts.py --check    # fail if those files are out of date
    python3 scripts/grafana_alerts.py verify [<grafana url>]
        # the local stack (`make up`): the local rules are provisioned, Grafana evaluates
        # them without errors, their queries run and the metrics they query have series
    python3 scripts/grafana_alerts.py wait <rule> <state> [--minutes N] [<grafana url>]
        # wait until a local rule (session-save-errors, history-latency) is in a state
        # (firing, pending, normal), e.g. during a fault-injection drill
    python3 scripts/grafana_alerts.py apply prod|dev --grafana https://ineedtofocus.grafana.net
        # Yacine only: create or update the environment's rule group in Grafana Cloud with
        # a short-lived service account token, asked for at the prompt
        # (_docs/observability.md, Import the alert rules)

Two rules per environment, on the key journey only, never on CPU or memory (tech_stack.md
§4, _docs/observability.md "Alerts"):

- **Session saves failing:** over the last 5 minutes, more than 5% of the sessions
  submitted failed (`outcome="error"` over all `focus_session_saves_total`, the complement
  of the dashboards' save success rate), with at least 10 sessions submitted.
- **History slow:** the p95 latency of history loads over the last 5 minutes is above 2 s,
  with at least 5 history loads in those 5 minutes.

Below either minimum the count query returns nothing, so the window is "no data" (Normal),
not a false condition: one failed save or one slow load at 3 a.m. is not user impact.

Grafana evaluates them every minute; a rule fires once its condition has held for one
more minute (the pending period). No data (no traffic) is normal, never an alert, and a
failing query keeps the rule's last state rather than raising an alert of its own.

The files are Grafana's alert provisioning format (what Grafana exports): the local
stack provisions `key-journey-local.json` (compose.yaml), and `apply` sends the prod or
dev group to Grafana Cloud through the alerting provisioning API. The queries are built
by scripts/grafana_dashboards.py's helpers, so the dashboards and the alerts can't drift.
Edit this file, never the JSON: `make test-scripts` fails when they differ. Stdlib only.
"""

from __future__ import annotations

import getpass
import json
import re
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path
from typing import Any

import grafana_dashboards as g

REPO = g.REPO
OUT_DIR = REPO / "infra" / "grafana" / "alerts"
ENVIRONMENTS = g.ENVIRONMENTS
DEPLOYED = ("prod", "dev")
FOLDER = "I Need To Focus"  # the folder the dashboards live in (#32)
FOLDER_UID = "focus-alerts"  # used only when `apply` has to create the folder
RUNBOOKS = "https://github.com/ybenzine/ineedtofocus/blob/main/_docs/runbooks"

# The thresholds (tech_stack.md §4). The dashboards draw the same lines.
WINDOW = "5m"
SAVE_ERROR_RATE_LIMIT = 0.05  # 1 - g.SAVE_SUCCESS_TARGET, checked by the tests
SAVE_MIN_SESSIONS = 10
HISTORY_MIN_LOADS = 5  # AC2, the product manager's decision on #33
HISTORY_P95_LIMIT_S = g.HISTORY_P95_LIMIT_S
INTERVAL_S = 60  # how often Grafana evaluates the group
PENDING = "1m"  # how long a condition must hold before the rule fires
EXPR = {"type": "__expr__", "uid": "__expr__"}


def group_name(env: str) -> str:
    return f"key-journey-{env}"


def rule_uid(env: str, rule: str) -> str:
    return f"focus-{rule}-{env}"


def datasource_uid(env: str) -> str:
    """The Prometheus data source: Grafana Cloud's built-in one, or grafana/otel-lgtm's."""
    return g.DATASOURCES["local" if env == "local" else "cloud"]["metrics"]


# Quiet windows must be "no data", never NaN. The journey counters exist from startup at 0
# (backend/app/metrics.py, zero_journey_series), so 5 minutes without traffic make the error
# rate 0/0 and the p95 a quantile of nothing, both NaN, and Grafana takes a NaN condition
# as true: the rule would fire every quiet night. Hence the `> 0` filters, which drop a
# zero or NaN result; an empty result is "no data", which these rules treat as OK.


def sessions_submitted(env: str) -> str:
    return f"sum(increase({g.SAVES}{g._sel(env)}[{WINDOW}]))"


def at_least(expr: str, minimum: int) -> str:
    """`expr` (one series) only when it is at least `minimum`; otherwise no data."""
    return f"{expr} >= {minimum}"


def history_loads(env: str) -> str:
    return f"sum(increase({g.HISTORY_LOADS}{g._sel(env)}[{WINDOW}]))"


def save_error_rate(env: str) -> str:
    """The dashboards' error rate (grafana_dashboards._error_rate), over windows that had
    sessions."""
    failed = g._sel(env, 'outcome="error"')
    errors = f"sum(increase({g.SAVES}{failed}[{WINDOW}]))"
    return f"(({errors}) or vector(0)) / ({sessions_submitted(env)} > 0)"


def history_p95(env: str) -> str:
    return (
        f"histogram_quantile(0.95, sum by (le) "
        f"(increase({g.HISTORY_DURATION}_bucket{g._sel(env)}[{WINDOW}]))) > 0"
    )


def _prom(env: str, ref: str, expr: str) -> dict[str, Any]:
    ds = {"type": "prometheus", "uid": datasource_uid(env)}
    return {
        "refId": ref,
        "relativeTimeRange": {"from": 600, "to": 0},
        "datasourceUid": ds["uid"],
        "model": {
            "refId": ref,
            "datasource": ds,
            "expr": expr,
            "instant": True,
            "range": False,
            "intervalMs": 1000,
            "maxDataPoints": 43200,
        },
    }


def _math(ref: str, expression: str) -> dict[str, Any]:
    return {
        "refId": ref,
        "relativeTimeRange": {"from": 0, "to": 0},
        "datasourceUid": EXPR["uid"],
        "model": {"refId": ref, "datasource": EXPR, "type": "math", "expression": expression},
    }


def _panel_id(env: str, title: str) -> int:
    for panel in g.dashboard(env)["panels"]:
        if panel["title"] == title:
            return int(panel["id"])
    raise KeyError(f"no panel {title!r} on {g.uid(env)}")


def _rule(
    env: str,
    name: str,
    title: str,
    data: list[dict[str, Any]],
    panel: str,
    summary: str,
    description: str,
) -> dict[str, Any]:
    return {
        "uid": rule_uid(env, name),
        "title": f"{title} ({env})",
        "condition": "C",
        "data": data,
        # No traffic is not an outage; a query that fails isn't user impact either.
        "noDataState": "OK",
        "execErrState": "KeepLast",
        "for": PENDING,
        "annotations": {
            "summary": summary,
            "description": description,
            "runbook_url": f"{RUNBOOKS}/{name}.md",
            "__dashboardUid__": g.uid(env),
            "__panelId__": str(_panel_id(env, panel)),
        },
        # What the routing (#34) and the on-call agent (#35) go by.
        "labels": {"service": g.SERVICE, "environment": env, "alert": name},
        "isPaused": False,
    }


def rules(env: str) -> list[dict[str, Any]]:
    pct = f"{SAVE_ERROR_RATE_LIMIT:.0%}"
    return [
        _rule(
            env,
            "session-save-errors",
            "Session saves failing",
            [
                _prom(env, "A", save_error_rate(env)),
                _prom(env, "B", at_least(sessions_submitted(env), SAVE_MIN_SESSIONS)),
                _math("C", f"$A > {SAVE_ERROR_RATE_LIMIT} && $B >= {SAVE_MIN_SESSIONS}"),
            ],
            "Save success rate (5 min windows, as the alert sees it)",
            f"Over {pct} of session saves are failing in {env}",
            f"{{{{ humanizePercentage $values.A.Value }}}} of the "
            f'{{{{ printf "%.0f" $values.B.Value }}}} sessions submitted in the last 5 minutes '
            f'failed (outcome="error"); the alert fires above {pct} with at least '
            f"{SAVE_MIN_SESSIONS} sessions. Users' sessions stay queued on their devices "
            "and sync once saves work again.",
        ),
        _rule(
            env,
            "history-latency",
            "History slow",
            [
                _prom(env, "A", history_p95(env)),
                _prom(env, "B", at_least(history_loads(env), HISTORY_MIN_LOADS)),
                _math("C", f"$A > {HISTORY_P95_LIMIT_S} && $B >= {HISTORY_MIN_LOADS}"),
            ],
            "History latency",
            f"History loads are slow in {env} (p95 over {HISTORY_P95_LIMIT_S} s)",
            "The 95th percentile of the "
            f'{{{{ printf "%.0f" $values.B.Value }}}} GET /api/history loads in the last '
            f"5 minutes is {{{{ humanizeDuration $values.A.Value }}}}; the alert fires above "
            f"{HISTORY_P95_LIMIT_S} s with at least {HISTORY_MIN_LOADS} loads.",
        ),
    ]


def provisioning(env: str) -> dict[str, Any]:
    """Grafana's file provisioning (and export) format for the environment's group."""
    return {
        "apiVersion": 1,
        "groups": [
            {
                "orgId": 1,
                "name": group_name(env),
                "folder": FOLDER,
                "interval": f"{INTERVAL_S}s",
                "rules": rules(env),
            }
        ],
    }


def api_group(env: str, folder_uid: str, datasource: str | None = None) -> dict[str, Any]:
    """The same group in the provisioning API's shape (PUT .../rule-groups/<group>)."""
    group: dict[str, Any] = {
        "title": group_name(env),
        "folderUid": folder_uid,
        "interval": INTERVAL_S,
        "rules": [],
    }
    for rule in rules(env):
        rule = {**rule, "folderUID": folder_uid, "ruleGroup": group_name(env), "orgID": 1}
        if datasource:
            rule["data"] = [_with_datasource(q, datasource) for q in rule["data"]]
        group["rules"].append(rule)
    return group


def _with_datasource(query: dict[str, Any], uid: str) -> dict[str, Any]:
    if query["datasourceUid"] == EXPR["uid"]:
        return query
    model = {**query["model"], "datasource": {"type": "prometheus", "uid": uid}}
    return {**query, "datasourceUid": uid, "model": model}


def render(env: str) -> str:
    return json.dumps(provisioning(env), indent=2) + "\n"


def path(env: str) -> Path:
    return OUT_DIR / f"key-journey-{env}.json"


def write() -> None:
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    for env in ENVIRONMENTS:
        path(env).write_text(render(env))
        print(f"wrote {path(env).relative_to(REPO)}")


def stale() -> list[str]:
    return [
        str(path(env).relative_to(REPO))
        for env in ENVIRONMENTS
        if not path(env).is_file() or path(env).read_text() != render(env)
    ]


def queries(env: str) -> list[tuple[str, str]]:
    """(rule title [refId], PromQL) of every data source query of the environment's rules."""
    return [
        (f"{rule['title']} [{q['refId']}]", q["model"]["expr"])
        for rule in rules(env)
        for q in rule["data"]
        if q["datasourceUid"] != EXPR["uid"]
    ]


# --- The local stack: verify and wait ---------------------------------------------------


def rule_states(grafana: str) -> dict[str, dict[str, Any]]:
    """Grafana's view of the local rules, by alert name: state, health, last error."""
    found = g._get(f"{grafana}/api/prometheus/grafana/api/v1/rules")
    states: dict[str, dict[str, Any]] = {}
    for group in found.get("data", {}).get("groups", []):
        if group.get("name") != group_name("local"):
            continue
        for rule in group.get("rules", []):
            name = (rule.get("labels") or {}).get("alert", rule.get("name"))
            states[name] = rule
    return states


SELECTOR = re.compile(r"\b[a-z_][a-z0-9_]*\{[^}]*\}")


def selectors(env: str) -> list[str]:
    """Every distinct `metric{labels}` the environment's rules query, in order."""
    return list(dict.fromkeys(m for _, expr in queries(env) for m in SELECTOR.findall(expr)))


def verify(grafana: str, wait_s: float = 0) -> list[str]:
    """Problems with the local rules in the running local stack (empty: none).

    Every query must run, and every metric selector in it must return series, not merely
    parse: a renamed metric or label would otherwise leave the rule quietly evaluating no
    data, which is never an alert. The selectors are checked rather than the whole
    expressions, because those are no data by design whenever the 5-minute window holds
    too little traffic (the `> 0` filters above): one history load makes the latency
    series exist, but its p95 needs a second sample. Needs the journey traffic `make
    check-stack` sends first (a save and a history load) and a metric export since; "no
    data" is retried for up to `wait_s` seconds."""
    deadline = time.monotonic() + wait_s
    while True:
        problems: list[str] = []
        try:
            states = rule_states(grafana)
        except (RuntimeError, OSError) as e:
            return [f"can't read the alert rules from {grafana}: {e}"]
        for rule in rules("local"):
            name = rule["labels"]["alert"]
            state = states.get(name)
            if state is None:
                problems.append(f"rule {name} is not provisioned in {grafana} (restart lgtm)")
            elif state.get("health") not in ("ok", "nodata", None) or state.get("lastError"):
                problems.append(f"rule {name} fails to evaluate: {state.get('lastError')}")
        for title, expr in queries("local"):
            try:
                g.run_query(grafana, {"datasource": {"type": "prometheus"}, "expr": expr})
            except (RuntimeError, OSError) as e:
                problems.append(f"{title}: {e}")
        for selector in selectors("local"):
            target = {"datasource": {"type": "prometheus"}, "expr": selector}
            try:
                series = g.run_query(grafana, target)
            except (RuntimeError, OSError) as e:
                problems.append(f"{selector}: {e}")
                continue
            if not series:
                problems.append(f"{selector} {g.NO_DATA} (unknown metric or label?)")
        if not any(g.NO_DATA in p for p in problems) or time.monotonic() > deadline:
            return problems
        time.sleep(5)


def normalised(state: str) -> str:
    """Grafana's rule states: inactive (normal), pending, firing; alert states: Normal..."""
    s = state.lower()
    return "normal" if s in ("inactive", "normal", "ok") else s


def wait(grafana: str, name: str, state: str, minutes: float) -> bool:
    deadline = time.monotonic() + minutes * 60
    last = None
    while True:
        try:
            current = normalised(str(rule_states(grafana).get(name, {}).get("state", "missing")))
        except (RuntimeError, OSError) as e:
            current = f"unreadable ({e})"
        if current != last:
            print(f"{time.strftime('%H:%M:%SZ', time.gmtime())}  {name}: {current}", flush=True)
            last = current
        if current == state:
            return True
        if time.monotonic() > deadline:
            return False
        time.sleep(10)


# --- Grafana Cloud: apply (Yacine) -----------------------------------------------------


class _NoRedirects(urllib.request.HTTPRedirectHandler):
    """Never follow a redirect: urllib would resend the Authorization header to wherever
    the response points. The 3xx surfaces as an HTTPError instead."""

    def redirect_request(self, *args: Any, **kwargs: Any) -> None:
        return None


# The opener every token-bearing request goes through.
_OPENER = urllib.request.build_opener(_NoRedirects())


def check_cloud_url(grafana: str) -> str:
    """The Grafana URL without a trailing slash; refuses anything but https, so the token
    never crosses the network in clear (a typo such as http:// included)."""
    parts = urllib.parse.urlsplit(grafana)
    if parts.scheme != "https" or not parts.hostname:
        raise RuntimeError(f"--grafana must be an https:// URL, not {grafana!r}")
    return grafana.rstrip("/")


def _call(grafana: str, token: str, method: str, api: str, body: Any = None) -> Any:
    req = urllib.request.Request(
        f"{grafana}{api}",
        data=None if body is None else json.dumps(body).encode(),
        method=method,
        headers={
            "Authorization": f"Bearer {token}",
            "Content-Type": "application/json",
            "Accept": "application/json",
            # Keep the rules editable in the Grafana UI (no "provisioned" lock).
            "X-Disable-Provenance": "true",
        },
    )
    try:
        with _OPENER.open(req, timeout=30) as r:
            raw = r.read()
    except urllib.error.HTTPError as e:
        if 300 <= e.code < 400:
            raise RuntimeError(
                f"{method} {api} -> HTTP {e.code} redirect to {e.headers.get('Location')!r},"
                " not followed (it would carry the token): use the stack's own URL"
            ) from None
        # Grafana's error bodies are messages, never the token.
        raise RuntimeError(f"{method} {api} -> HTTP {e.code}: {e.read().decode()[:300]}") from None
    return json.loads(raw) if raw else None


def folder_uid(grafana: str, token: str) -> str:
    """The UID of the `I Need To Focus` folder, creating it if it doesn't exist."""
    for folder in _call(grafana, token, "GET", "/api/folders?limit=1000") or []:
        if folder.get("title") == FOLDER:
            return str(folder["uid"])
    created = _call(grafana, token, "POST", "/api/folders", {"uid": FOLDER_UID, "title": FOLDER})
    print(f"created folder {FOLDER!r}")
    return str(created["uid"])


def prometheus_uid(grafana: str, token: str, wanted: str) -> str:
    """`wanted` if the stack has that data source; otherwise its one `grafanacloud-*-prom`
    Prometheus data source. Fails rather than guess between several."""
    sources = _call(grafana, token, "GET", "/api/datasources") or []
    if any(s.get("uid") == wanted for s in sources):
        return wanted
    candidates = [
        s
        for s in sources
        if s.get("type") == "prometheus"
        and str(s.get("name", "")).startswith("grafanacloud-")
        and str(s.get("name", "")).endswith("-prom")
    ]
    if len(candidates) != 1:
        names = ", ".join(f"{s.get('name')} ({s.get('uid')})" for s in candidates) or "none"
        raise RuntimeError(
            f"no data source {wanted!r}, and not exactly one grafanacloud-*-prom ({names}): "
            "pass --datasource <uid>"
        )
    print(f"using data source {candidates[0]['name']} ({candidates[0]['uid']})")
    return str(candidates[0]["uid"])


def apply(grafana: str, env: str, token: str, datasource: str | None = None) -> None:
    grafana = check_cloud_url(grafana)
    uid = folder_uid(grafana, token)
    source = prometheus_uid(grafana, token, datasource or datasource_uid(env))
    group = api_group(env, uid, None if source == datasource_uid(env) else source)
    api = f"/api/v1/provisioning/folder/{urllib.parse.quote(uid)}/rule-groups/{group_name(env)}"
    _call(grafana, token, "PUT", api, group)
    print(f"ok    {group_name(env)}: {len(group['rules'])} rules in {FOLDER!r} on {grafana}")


def _option(argv: list[str], name: str) -> str | None:
    if name in argv:
        at = argv.index(name)
        if at + 1 >= len(argv):
            raise SystemExit(f"{name} needs a value")
        value = argv[at + 1]
        del argv[at : at + 2]
        return value
    return None


def main(argv: list[str]) -> int:
    argv = list(argv)
    if argv[:1] == ["--check"]:
        out_of_date = stale()
        if out_of_date:
            print(
                f"FAIL  out of date: {', '.join(out_of_date)}. "
                "Run python3 scripts/grafana_alerts.py",
                file=sys.stderr,
            )
            return 1
        print("ok    alert rules are up to date")
        return 0
    if argv[:1] in (["verify"], ["wait"]):
        from check_local_stack import GRAFANA

        command = argv.pop(0)
        minutes = float(_option(argv, "--minutes") or 10)
        if command == "verify":
            grafana = argv[0] if argv else GRAFANA
            problems = verify(grafana, wait_s=60)
            for problem in problems:
                print(f"FAIL  alert rules: {problem}", file=sys.stderr)
            if problems:
                return 1
            print(f"ok    {group_name('local')} is provisioned and its metrics have series")
            return 0
        if len(argv) not in (2, 3) or normalised(argv[1]) not in ("firing", "pending", "normal"):
            print(__doc__, file=sys.stderr)
            return 2
        grafana = argv[2] if len(argv) == 3 else GRAFANA
        return 0 if wait(grafana, argv[0], normalised(argv[1]), minutes) else 1
    if argv[:1] == ["apply"]:
        cloud = _option(argv, "--grafana")
        datasource = _option(argv, "--datasource")
        if len(argv) != 2 or argv[1] not in DEPLOYED or not cloud:
            print(__doc__, file=sys.stderr)
            return 2
        try:  # before the token is typed
            cloud = check_cloud_url(cloud)
        except RuntimeError as e:
            print(f"FAIL  {e}", file=sys.stderr)
            return 2
        token = getpass.getpass("Grafana service account token (not echoed): ").strip()
        if not token:
            print("no token given", file=sys.stderr)
            return 2
        try:
            apply(cloud, argv[1], token, datasource)
        except (RuntimeError, OSError) as e:
            print(f"FAIL  {e}", file=sys.stderr)
            return 1
        return 0
    if argv:
        print(__doc__, file=sys.stderr)
        return 2
    write()
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
