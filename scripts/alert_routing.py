#!/usr/bin/env python3
"""Alert routing (#34): the contact point and notification policy that wake the on-call agent.

    python3 scripts/alert_routing.py             # write infra/grafana/routing/oncall-github.json
    python3 scripts/alert_routing.py --check     # fail if that file is out of date
    python3 scripts/alert_routing.py verify [<grafana url>]
        # the local stack (`make up`): the local Grafana renders the payload template, for
        # every alert, environment and status, into a dispatch scripts/alert_dispatch.py
        # accepts
    python3 scripts/alert_routing.py apply cloud --grafana https://ineedtofocus.grafana.net
        # Yacine only: create or update the contact point and its notification policy in
        # Grafana Cloud. Asks for a short-lived Grafana service account token and the GitHub
        # dispatch token at hidden prompts (_docs/observability.md, "Alert routing")
    python3 scripts/alert_routing.py apply local [--url <stand-in url>] [--grafana <url>]
        # the local drill: the same contact point in the local Grafana, posting to
        # `alert_dispatch.py receive` with its stand-in token, for environment=local
    python3 scripts/alert_routing.py test cloud|local --env <env> --alert <alert>
        [--grafana <url>] [--namespace <namespace>]
        # send one synthetic notification through the stored contact point; in Grafana
        # Cloud that's a real dispatch, which runs the on-call workflow. The receivers API's
        # namespace comes from Grafana's frontend settings (`stacks-<id>` in Grafana
        # Cloud, `default` locally); --namespace overrides that lookup

Grafana alert -> notification policy -> webhook contact point -> GitHub REST API
`POST /repos/ybenzine/ineedtofocus/dispatches` -> `repository_dispatch` event
`grafana-alert` -> .github/workflows/oncall.yml. No relay: Grafana's webhook sends the
token in its Authorization header and shapes the body with a custom payload template, so
nothing of ours sits in between (_docs/observability.md, "Alert routing", for the decision).

The route matches the labels the alert rules set (#33, scripts/grafana_alerts.py):
`service=ineedtofocus` and `environment=prod|dev`, and groups by alert and environment,
so one notification is one alert in one environment. Firing and resolved both go out.
The token is never in this file or the repo: `apply` reads it at a prompt and Grafana
stores it encrypted; reading the contact point back shows `[REDACTED]`. Stdlib only.
"""

from __future__ import annotations

import getpass
import json
import re
import sys
import urllib.error
import urllib.parse
import urllib.request
from datetime import UTC, datetime, timedelta
from typing import Any

import alert_dispatch as d
import grafana_alerts as ga
import grafana_dashboards as g

REPO = g.REPO
OUT = REPO / "infra" / "grafana" / "routing" / "oncall-github.json"
CONTACT_POINT = "focus-oncall-github"  # its name and UID, in Grafana Cloud and locally
DISPATCH_URL = f"https://api.github.com{d.DISPATCH_PATH}"
LOCAL_URL = f"http://host.docker.internal:8765{d.DISPATCH_PATH}"  # alert_dispatch.py receive
# GitHub's recommended headers; Grafana adds Content-Type and its User-Agent.
HEADERS = {"Accept": "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28"}
# Which environments' alerts each Grafana routes, and the traces data source its links use.
ROUTED: dict[str, tuple[str, ...]] = {"cloud": d.DEPLOYED, "local": ("local",)}
TRACES_UID = {target: g.DATASOURCES[target]["traces"] for target in ROUTED}
TARGETS = tuple(ROUTED)
GROUP_BY = ["alertname", "alert", "environment"]
GROUP_WAIT = "10s"  # wake on-call quickly: the rule's pending period already debounces
GROUP_INTERVAL = "1m"  # a resolved notification follows within a minute
REPEAT_INTERVAL = "4h"  # re-sent while still firing; #35 updates the open incident
TRACES_BEFORE = timedelta(minutes=30)  # the trace links start this long before the alert
TRACES_AFTER = timedelta(minutes=10)  # and end this long after it resolved
# Grafana's receivers API (the older .../config/api/v1/receivers/test is gone in Grafana 13),
# a Kubernetes-style API under a namespace: `default` for org 1 of an OSS Grafana (the local
# stack), `stacks-<stack id>` in Grafana Cloud, where `default` gets 403 "invalid namespace"
# (#219). Grafana names it in its frontend settings; see namespace().
RECEIVERS_API = "/apis/notifications.alerting.grafana.app/v1beta1/namespaces/{namespace}"
FRONTEND_SETTINGS = "/api/frontend/settings"
DEFAULT_NAMESPACE = "default"
# A Kubernetes namespace is a DNS label: it can't add a path segment, a query or a host.
NAMESPACE = re.compile(r"[a-z0-9]([-a-z0-9]{0,61}[a-z0-9])?")
TIME = "2006-01-02T15:04:05Z"  # Go's layout for d.TIMESTAMP (Grafana passes UTC)
# The traces worth opening first, per alert.
TRACES = {
    "session-save-errors": 'span.http.route=~"/api/sessions|/api/sessions/sync" && status=error',
    "history-latency": 'span.http.route="/api/history" && duration > 1s',
}


def runbook_link(alert: str) -> str:
    """The alert's runbook if `_docs/runbooks/<alert>.md` is in the repo, otherwise the
    runbooks index, so a dispatch never links a missing file. The rules' `runbook_url`
    annotation (#33) names the runbook before #35 writes it, so the template doesn't use
    it. When a runbook lands, `--check` goes stale: regenerate and re-apply."""
    if (REPO / "_docs" / "runbooks" / f"{alert}.md").is_file():
        return f"{d.RUNBOOKS}{alert}.md"
    return d.RUNBOOK_INDEX


def _nanoseconds(delta: timedelta) -> int:
    return int(delta.total_seconds()) * 10**9


def payload_template(traces_uid: str) -> str:
    """The webhook's custom payload: a Go template Grafana renders per notification into
    GitHub's dispatch body (alert_dispatch.py documents the contract and checks it).

    One notification holds one group (one alert in one environment, GROUP_BY); its first
    firing alert, or its first alert if all resolved, is the one described. Only named
    labels and annotations are copied, never all of them. `coll.Dict` and `data.ToJSON`
    build the JSON, so every value is escaped."""

    def traceql(alert: str) -> str:
        # g._traceql with the environment left to printf; raw strings keep the quotes.
        return "`" + g._traceql("%s", TRACES[alert]) + "`"

    saves, history = d.ALERTS
    return f"""\
{{{{- /* scripts/alert_routing.py (#34): one notification -> one GitHub dispatch */ -}}}}
{{{{- $a := index .Alerts 0 -}}}}
{{{{- if .Alerts.Firing }}}}{{{{ $a = index .Alerts.Firing 0 }}}}{{{{ end -}}}}
{{{{- $env := $a.Labels.environment -}}}}
{{{{- $alert := $a.Labels.alert -}}}}
{{{{- $grafana := reReplaceAll "/*$" "/" .ExternalURL -}}}}
{{{{- $from := printf "%d" ($a.StartsAt.Add -{_nanoseconds(TRACES_BEFORE)}).UnixMilli -}}}}
{{{{- $to := "now" -}}}}
{{{{- $resolvedAt := "" -}}}}
{{{{- if eq $a.Status "resolved" -}}}}
  {{{{- $to = printf "%d" ($a.EndsAt.Add {_nanoseconds(TRACES_AFTER)}).UnixMilli -}}}}
  {{{{- $resolvedAt = $a.EndsAt.UTC.Format "{TIME}" -}}}}
{{{{- end -}}}}
{{{{- $traceql := printf {traceql(saves)} $env -}}}}
{{{{- if eq $alert "{history}" }}}}{{{{ $traceql = printf {traceql(history)} $env }}}}{{{{ end -}}}}
{{{{- $tempo := coll.Dict "type" "tempo" "uid" "{traces_uid}" -}}}}
{{{{- $query := coll.Dict "refId" "A" "datasource" $tempo "queryType" "traceql"
  "query" $traceql "limit" 20 "tableType" "traces" -}}}}
{{{{- $range := coll.Dict "from" $from "to" $to -}}}}
{{{{- $panes := coll.Dict "alert" (coll.Dict
  "datasource" "{traces_uid}" "queries" (coll.Slice $query) "range" $range) -}}}}
{{{{- /* runbook_link(): the alert's runbook once it's in the repo, the index until then */ -}}}}
{{{{- $runbook := "{runbook_link(saves)}" -}}}}
{{{{- if eq $alert "{history}" }}}}{{{{ $runbook = "{runbook_link(history)}" }}}}{{{{ end -}}}}
{{{{- /* A contact point test has no rule behind it: link the alert list instead. */ -}}}}
{{{{- $rule := $a.GeneratorURL -}}}}
{{{{- if not (match "^https?://" $rule) -}}}}
  {{{{- $search := printf "label:alert=%s label:environment=%s" $alert $env -}}}}
  {{{{- $rule = printf "%salerting/list?search=%s" $grafana (urlquery $search) -}}}}
{{{{- end -}}}}
{{{{- $dashboard := printf "%sd/focus-key-journey-%s?orgId=1&from=%s&to=%s"
  $grafana $env $from $to -}}}}
{{{{- $traces := printf "%sexplore?schemaVersion=1&orgId=1&panes=%s"
  $grafana (urlquery ($panes | data.ToJSON)) -}}}}
{{{{- coll.Dict
  "event_type" "{d.EVENT_TYPE}"
  "client_payload" (coll.Dict
    "alert" $alert
    "environment" $env
    "status" $a.Status
    "title" $a.Labels.alertname
    "summary" $a.Annotations.summary
    "description" $a.Annotations.description
    "started_at" ($a.StartsAt.UTC.Format "{TIME}")
    "resolved_at" $resolvedAt
    "links" (coll.Dict
      "dashboard" $dashboard
      "traces" $traces
      "runbook" $runbook
      "alert" $rule))
  | data.ToJSON -}}}}
"""


def contact_point(target: str, url: str, traces_uid: str | None = None) -> dict[str, Any]:
    """The webhook contact point, in the provisioning API's shape, without its token."""
    return {
        "uid": CONTACT_POINT,
        "name": CONTACT_POINT,
        "type": "webhook",
        "settings": {
            "url": url,
            "httpMethod": "POST",
            "authorization_scheme": "Bearer",
            "headers": dict(HEADERS),
            "maxAlerts": 0,
            "payload": {"template": payload_template(traces_uid or TRACES_UID[target])},
        },
        # Resolved notifications too: #35 confirms the alert resolves.
        "disableResolveMessage": False,
    }


def route(target: str) -> dict[str, Any]:
    """The notification policy, a child of the root policy, for the routed environments."""
    envs = ROUTED[target]
    return {
        "receiver": CONTACT_POINT,
        "object_matchers": [
            ["service", "=", g.SERVICE],
            ["environment", "=~", "|".join(envs)],
        ],
        "group_by": list(GROUP_BY),
        "group_wait": GROUP_WAIT,
        "group_interval": GROUP_INTERVAL,
        "repeat_interval": REPEAT_INTERVAL,
        "continue": False,
    }


def model() -> dict[str, Any]:
    """What `apply cloud` sends Grafana Cloud, the token aside."""
    return {
        "contactPoint": contact_point("cloud", DISPATCH_URL),
        "route": route("cloud"),
    }


def render() -> str:
    return json.dumps(model(), indent=2) + "\n"


def write() -> None:
    OUT.parent.mkdir(parents=True, exist_ok=True)
    OUT.write_text(render())
    print(f"wrote {OUT.relative_to(REPO)}")


def stale() -> bool:
    return not OUT.is_file() or OUT.read_text() != render()


def stale_reason() -> str:
    """Why the committed JSON is out of date, naming the usual cause when it's that one."""
    fix = (
        "run python3 scripts/alert_routing.py and commit the result; after the merge, "
        "Yacine re-runs `apply cloud` (_docs/observability.md, Alert routing)"
    )
    committed = OUT.read_text() if OUT.is_file() else ""
    moved = [a for a in d.ALERTS if json.dumps(runbook_link(a))[1:-1] not in committed]
    if committed and moved:
        return (
            f"{OUT.relative_to(REPO)} is out of date because a runbook was added or removed "
            f"in _docs/runbooks/ ({', '.join(moved)}), which changes the dispatch's runbook "
            f"link: {fix}"
        )
    return f"{OUT.relative_to(REPO)} is out of date: {fix}"


# --- Grafana's API -----------------------------------------------------------------------


def call(grafana: str, token: str | None, method: str, api: str, body: Any = None) -> Any:
    headers = {
        "Content-Type": "application/json",
        "Accept": "application/json",
        # Keep the contact point and policy editable in the Grafana UI.
        "X-Disable-Provenance": "true",
    }
    if token:
        headers["Authorization"] = f"Bearer {token}"
    req = urllib.request.Request(
        f"{grafana}{api}",
        data=None if body is None else json.dumps(body).encode(),
        method=method,
        headers=headers,
    )
    try:
        # #33's opener: a redirect is never followed, since urllib would resend the
        # Authorization header (and a body holding the dispatch token) to its target.
        with ga._OPENER.open(req, timeout=30) as r:
            raw = r.read()
    except urllib.error.HTTPError as e:
        if 300 <= e.code < 400:
            raise RuntimeError(
                f"{method} {api} -> HTTP {e.code} redirect to {e.headers.get('Location')!r},"
                " not followed (it would carry the token): use the stack's own URL"
            ) from None
        # Grafana's error bodies are messages; they never echo a token.
        raise RuntimeError(f"{method} {api} -> HTTP {e.code}: {e.read().decode()[:300]}") from None
    return json.loads(raw) if raw else None


LOOPBACK = ("127.0.0.1", "localhost", "::1")


def check_grafana_url(target: str, grafana: str) -> str:
    """The Grafana URL `apply` and `test` may send tokens to, without a trailing slash:
    Grafana Cloud only over https (#33's check_cloud_url), the local Grafana only on
    this machine. Checked before any token is asked for."""
    if target == "cloud":
        return ga.check_cloud_url(grafana)
    parts = urllib.parse.urlsplit(grafana)
    if parts.scheme not in ("http", "https") or parts.hostname not in LOOPBACK:
        raise RuntimeError(f"--grafana for local must be this machine's Grafana, not {grafana!r}")
    return grafana.rstrip("/")


def render_template(grafana: str, template: str, alerts: list[dict[str, Any]]) -> str:
    """Grafana's template preview: render `template` for `alerts` as a notification."""
    result = call(
        grafana,
        None,
        "POST",
        "/api/alertmanager/grafana/config/api/v1/templates/test",
        {
            "name": "focus-dispatch",
            "template": '{{ define "focus-dispatch" }}' + template + "{{ end }}",
            "alerts": alerts,
        },
    )
    if result.get("errors"):
        raise RuntimeError(f"the template doesn't render: {result['errors']}")
    return str(result["results"][0]["text"])


def synthetic_alert(
    grafana: str, env: str, alert: str, status: str, now: datetime | None = None
) -> dict[str, Any]:
    """An alert as the rules (#33) raise it, for the template preview and `test`: the
    rule's own labels, title and summary, and its description with zero in every slot
    ("0% of the 0 sessions submitted …"): nothing failed. The check pins the description to
    the rule's template (#212), so a synthetic alert can't say anything else."""
    now = now or datetime.now(UTC).replace(microsecond=0)
    starts = now - timedelta(minutes=12 if status == "resolved" else 2)
    ends = now - timedelta(minutes=1) if status == "resolved" else now + timedelta(hours=1)
    (rule,) = [rule for rule in ga.rules(env) if rule["labels"]["alert"] == alert]
    return {
        "labels": {
            **rule["labels"],
            "alertname": rule["title"],
            "grafana_folder": ga.FOLDER,
        },
        "annotations": {
            "summary": rule["annotations"]["summary"],
            "description": d.example_description(rule["annotations"]["description"]),
            "runbook_url": rule["annotations"]["runbook_url"],
        },
        "startsAt": starts.isoformat().replace("+00:00", "Z"),
        "endsAt": ends.isoformat().replace("+00:00", "Z"),
        "generatorURL": f"{grafana}alerting/grafana/focus-{alert}-{env}/view?orgId=1",
    }


def external_url(grafana: str) -> str:
    """The root URL Grafana puts in its notifications (`.ExternalURL`)."""
    text = render_template(grafana, '{{ reReplaceAll "/*$" "/" .ExternalURL }}', [])
    return text.strip()


def verify(grafana: str) -> list[str]:
    """Problems with the payload template, rendered by the running local Grafana (empty:
    none). Covers every alert, both deployed environments and both statuses, plus a
    contact point test (firing, with no rule behind it, so no generator URL)."""
    try:
        base = external_url(grafana)
    except (RuntimeError, OSError) as e:
        return [f"can't render templates in {grafana}: {e}"]
    template = contact_point("cloud", DISPATCH_URL, "tempo")["settings"]["payload"]["template"]
    found: list[str] = []
    for env in d.DEPLOYED:
        for alert in d.ALERTS:
            for case_name, status in (
                ("firing", "firing"),
                ("resolved", "resolved"),
                ("test", "firing"),
            ):
                case = f"{alert} {case_name} in {env}"
                sample = synthetic_alert(base, env, alert, status)
                if case_name == "test":
                    del sample["generatorURL"]
                try:
                    body = json.loads(render_template(grafana, template, [sample]))
                except (RuntimeError, OSError, json.JSONDecodeError) as e:
                    found.append(f"{case}: {e}")
                    continue
                problems = d.request_problems(body, grafana=base)
                found += [f"{case}: {p}" for p in problems]
                if not problems and (
                    body["client_payload"]["status"] != status
                    or body["client_payload"]["environment"] != env
                    or body["client_payload"]["alert"] != alert
                ):
                    found.append(f"{case}: rendered as {body['client_payload']}")
    return found


def traces_uid(grafana: str, token: str, wanted: str) -> str:
    """`wanted` if the stack has it; otherwise its one `grafanacloud-*-traces` data source."""
    sources = call(grafana, token, "GET", "/api/datasources") or []
    if any(s.get("uid") == wanted for s in sources):
        return wanted
    candidates = [
        s
        for s in sources
        if s.get("type") == "tempo"
        and str(s.get("name", "")).startswith("grafanacloud-")
        and str(s.get("name", "")).endswith("-traces")
    ]
    if len(candidates) != 1:
        names = ", ".join(f"{s.get('name')} ({s.get('uid')})" for s in candidates) or "none"
        raise RuntimeError(
            f"no data source {wanted!r}, and not exactly one grafanacloud-*-traces ({names})"
        )
    print(f"using data source {candidates[0]['name']} ({candidates[0]['uid']})")
    return str(candidates[0]["uid"])


def merged_policy(tree: dict[str, Any], ours: dict[str, Any]) -> dict[str, Any]:
    """The policy tree with our route first among the root's children, replacing any
    earlier copy of it; every other route stays as it was."""
    others = [r for r in tree.get("routes") or [] if r.get("receiver") != CONTACT_POINT]
    return {**tree, "routes": [ours, *others]}


def apply(
    grafana: str,
    target: str,
    grafana_token: str | None,
    dispatch_token: str,
    url: str,
) -> None:
    grafana = check_grafana_url(target, grafana)
    traces = TRACES_UID[target]
    if target == "cloud":
        assert grafana_token
        traces = traces_uid(grafana, grafana_token, traces)
    point = contact_point(target, url, traces)
    existing = [
        p
        for p in call(grafana, grafana_token, "GET", "/api/v1/provisioning/contact-points") or []
        if p.get("uid") == CONTACT_POINT
    ]
    if not dispatch_token and not existing:
        raise RuntimeError("the contact point doesn't exist yet, so it needs the token")
    # Grafana keeps the stored secret when it's sent back as "[REDACTED]".
    point["settings"]["authorization_credentials"] = dispatch_token or "[REDACTED]"
    if existing:
        call(
            grafana,
            grafana_token,
            "PUT",
            f"/api/v1/provisioning/contact-points/{CONTACT_POINT}",
            point,
        )
        print(f"ok    updated contact point {CONTACT_POINT} -> {url}")
    else:
        call(grafana, grafana_token, "POST", "/api/v1/provisioning/contact-points", point)
        print(f"ok    created contact point {CONTACT_POINT} -> {url}")
    tree = call(grafana, grafana_token, "GET", "/api/v1/provisioning/policies")
    call(
        grafana,
        grafana_token,
        "PUT",
        "/api/v1/provisioning/policies",
        merged_policy(tree, route(target)),
    )
    envs = "|".join(ROUTED[target])
    print(f"ok    notification policy: service={g.SERVICE}, environment=~{envs} -> {CONTACT_POINT}")


def check_namespace(value: str) -> str:
    """`value` if it's a valid Kubernetes namespace, so it can only ever name one path
    segment of the receivers API on the same Grafana."""
    if not NAMESPACE.fullmatch(value):
        raise RuntimeError(f"{value!r} isn't a Grafana namespace (like default or stacks-123)")
    return value


def namespace(grafana: str, token: str | None) -> str:
    """The namespace of the token's org, as Grafana's frontend settings name it (the
    Grafana UI reads it from there too): `stacks-<stack id>` in Grafana Cloud, `default`
    for org 1 of an OSS Grafana. `default` if the settings don't name one."""
    settings = call(grafana, token, "GET", FRONTEND_SETTINGS)
    found = settings.get("namespace") if isinstance(settings, dict) else None
    if not found:
        print(
            f"note  {FRONTEND_SETTINGS} names no namespace: using {DEFAULT_NAMESPACE!r}"
            " (pass --namespace to choose another)"
        )
        return DEFAULT_NAMESPACE
    return check_namespace(str(found))


def send_test(
    grafana: str,
    token: str | None,
    target: str,
    env: str,
    alert: str,
    ns: str | None = None,
) -> None:
    """One synthetic notification through the stored contact point, with its stored token:
    what the contact point's **Test** button does with custom labels. Grafana sends a
    test as a firing alert with no rule behind it. `ns` is the receivers API's namespace,
    looked up in Grafana unless given."""
    grafana = check_grafana_url(target, grafana)
    ns = check_namespace(ns) if ns is not None else namespace(grafana, token)
    api = RECEIVERS_API.format(namespace=ns)
    receivers = call(grafana, token, "GET", f"{api}/receivers") or {}
    found = [
        (item["metadata"]["name"], integration)
        for item in receivers.get("items", [])
        for integration in item["spec"].get("integrations", [])
        if integration.get("uid") == CONTACT_POINT
    ]
    if not found:
        raise RuntimeError(
            f"no contact point {CONTACT_POINT} in namespace {ns}: run apply {target} first"
        )
    name, integration = found[0]
    sample = synthetic_alert(grafana + "/", env, alert, "firing")
    result = call(
        grafana,
        token,
        "POST",
        f"{api}/receivers/{urllib.parse.quote(name, safe='')}/test",
        {
            "integration": {
                "uid": integration["uid"],
                "type": integration["type"],
                "version": integration.get("version", "v1"),
                "settings": integration["settings"],
                # Use the stored token: it's never read back.
                "secureFields": integration.get("secureFields", {}),
                "disableResolveMessage": False,
            },
            "alert": {"labels": sample["labels"], "annotations": sample["annotations"]},
        },
    )
    if (result or {}).get("status") != "success":
        raise RuntimeError(f"the test notification failed: {(result or {}).get('error')}")
    print(f"ok    sent a synthetic {alert} firing in {env} through {CONTACT_POINT} ({ns})")


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
        if stale():
            print(f"FAIL  {stale_reason()}", file=sys.stderr)
            return 1
        print("ok    alert routing is up to date")
        return 0
    if argv[:1] == ["verify"]:
        from check_local_stack import GRAFANA

        grafana = argv[1] if len(argv) > 1 else GRAFANA
        problems = verify(grafana)
        for problem in problems:
            print(f"FAIL  alert routing: {problem}", file=sys.stderr)
        if problems:
            return 1
        print("ok    the dispatch template renders a valid dispatch for every alert and status")
        return 0
    if argv[:1] in (["apply"], ["test"]):
        from check_local_stack import GRAFANA

        command = argv.pop(0)
        grafana = (_option(argv, "--grafana") or "").rstrip("/")
        url = _option(argv, "--url") or LOCAL_URL
        env = _option(argv, "--env")
        alert = _option(argv, "--alert")
        ns = _option(argv, "--namespace")
        if len(argv) != 1 or argv[0] not in TARGETS:
            print(__doc__, file=sys.stderr)
            return 2
        target = argv[0]
        if ns is not None and command != "test":
            print("--namespace is for test only", file=sys.stderr)
            return 2
        if target == "cloud" and not grafana:
            print("apply cloud and test cloud need --grafana <Grafana Cloud URL>", file=sys.stderr)
            return 2
        try:
            grafana = check_grafana_url(target, grafana or GRAFANA)
            if ns is not None:
                ns = check_namespace(ns)
        except RuntimeError as e:
            print(f"FAIL  {e}", file=sys.stderr)
            return 2
        token = None
        if target == "cloud":
            token = getpass.getpass("Grafana service account token (not echoed): ").strip()
            if not token:
                print("no token given", file=sys.stderr)
                return 2
        try:
            if command == "apply":
                prompt = (
                    "GitHub dispatch token (not echoed; blank keeps the stored one): "
                    if target == "cloud"
                    else "Stand-in token printed by alert_dispatch.py receive: "
                )
                dispatch_token = getpass.getpass(prompt).strip()
                apply(
                    grafana,
                    target,
                    token,
                    dispatch_token,
                    DISPATCH_URL if target == "cloud" else url,
                )
            else:
                envs = ROUTED[target]
                if env is None or env not in envs or alert is None or alert not in d.ALERTS:
                    print(
                        f"test needs --env {'|'.join(envs)} --alert {'|'.join(d.ALERTS)}",
                        file=sys.stderr,
                    )
                    return 2
                send_test(grafana, token, target, env, alert, ns)
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
