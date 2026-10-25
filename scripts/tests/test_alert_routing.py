"""Alert routing (#34): the contact point and notification policy that send firing and
resolved alerts to GitHub, and the workflow that receives them. No Grafana here:
`make check-stack` renders the payload template in the local Grafana (`verify`)."""

from __future__ import annotations

import io
import json
import re
import urllib.parse
import urllib.request
from pathlib import Path
from typing import Any

import alert_dispatch as d
import alert_routing as r
import grafana_alerts as ga
import grafana_dashboards as g
import pytest
import yaml  # type: ignore[import-untyped]  # no stubs in the locked env

REPO = Path(__file__).resolve().parents[2]
WORKFLOW = REPO / ".github" / "workflows" / "oncall.yml"
ALERT_RULES = REPO / "infra" / "grafana" / "alerts"


def template() -> str:
    return str(r.model()["contactPoint"]["settings"]["payload"]["template"])


def test_committed_json_is_what_the_script_generates() -> None:
    assert not r.stale(), r.stale_reason()
    assert json.loads(r.OUT.read_text()) == r.model()


def test_a_new_runbook_is_named_as_the_reason_the_json_is_stale(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """#35 adding a runbook makes the JSON stale; the failure says so and what to do."""
    out = tmp_path / "infra" / "grafana" / "routing" / "oncall-github.json"
    out.parent.mkdir(parents=True)
    monkeypatch.setattr(r, "REPO", tmp_path)
    monkeypatch.setattr(r, "OUT", out)
    out.write_text(r.render())  # every alert links the index: no runbooks in tmp_path
    assert not r.stale()
    (tmp_path / "_docs" / "runbooks").mkdir(parents=True)
    (tmp_path / "_docs" / "runbooks" / "history-latency.md").write_text("# History slow\n")
    assert r.stale()
    reason = r.stale_reason()
    assert "a runbook was added or removed in _docs/runbooks/ (history-latency)" in reason
    assert "python3 scripts/alert_routing.py" in reason and "apply cloud" in reason


def test_the_contact_point_calls_githubs_dispatch_api_for_this_repo() -> None:
    point = r.model()["contactPoint"]
    settings = point["settings"]
    assert point["type"] == "webhook"
    assert settings["url"] == "https://api.github.com/repos/ybenzine/ineedtofocus/dispatches"
    assert settings["httpMethod"] == "POST"
    assert settings["authorization_scheme"] == "Bearer"
    assert settings["headers"]["Accept"] == "application/vnd.github+json"
    assert point["disableResolveMessage"] is False  # resolved alerts go out too


def test_no_token_in_the_repo() -> None:
    """The dispatch token lives only in Grafana Cloud's contact point."""
    assert "authorization_credentials" not in r.OUT.read_text()
    assert not re.search(r"gh[pousr]_[A-Za-z0-9]{20,}|github_pat_", r.OUT.read_text())
    assert "password" not in r.model()["contactPoint"]["settings"]


def test_agents_cant_send_a_dispatch() -> None:
    """Only Grafana's token wakes on-call: the agent account's `gh` is denied the
    dispatch API (_docs/observability.md, "The token")."""
    settings = json.loads((REPO / ".claude" / "settings.json").read_text())
    assert "Bash(gh api *dispatches*)" in settings["permissions"]["deny"]


def test_the_route_sends_prod_and_dev_journey_alerts_to_it() -> None:
    route = r.model()["route"]
    assert route["receiver"] == r.CONTACT_POINT == r.model()["contactPoint"]["name"]
    assert route["object_matchers"] == [
        ["service", "=", g.SERVICE],
        ["environment", "=~", "prod|dev"],
    ]
    assert {"alert", "environment"} <= set(route["group_by"])
    assert route["continue"] is False


def _matches(route: dict[str, Any], labels: dict[str, str]) -> bool:
    for name, op, value in route["object_matchers"]:
        if op == "=" and labels.get(name) != value:
            return False
        if op == "=~" and not re.fullmatch(value, labels.get(name, "")):
            return False
    return True


def test_the_route_matches_the_alert_rules() -> None:
    """Every prod and dev rule (#33) is routed, carrying the labels and annotations the
    payload reads; the local rules never are, in Grafana Cloud."""
    route = r.model()["route"]
    for env in g.ENVIRONMENTS:
        data = json.loads((ALERT_RULES / f"key-journey-{env}.json").read_text())
        rules = [rule for group in data["groups"] for rule in group["rules"]]
        assert {rule["labels"]["alert"] for rule in rules} == set(d.ALERTS)
        for rule in rules:
            assert _matches(route, rule["labels"]) is (env in d.DEPLOYED), rule["uid"]
            assert rule["labels"]["environment"] == env
            assert {"summary", "description"} <= set(rule["annotations"])


def test_runbook_links_never_point_at_a_missing_file() -> None:
    """#33's rules name runbooks #35 writes; until a runbook exists the dispatch links
    the runbooks index instead."""
    linked = re.findall(re.escape(d.RUNBOOKS) + r"([\w.-]+)", template())
    assert len(linked) == len(d.ALERTS)
    for name in linked:
        assert (REPO / "_docs" / "runbooks" / name).is_file(), name
    for alert in d.ALERTS:
        assert r.runbook_link(alert) in template(), r.stale_reason()


def test_runbook_link_is_the_alerts_own_once_it_exists(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setattr(r, "REPO", tmp_path)
    assert r.runbook_link("history-latency") == d.RUNBOOK_INDEX
    (tmp_path / "_docs" / "runbooks").mkdir(parents=True)
    (tmp_path / "_docs" / "runbooks" / "history-latency.md").write_text("# History slow\n")
    assert r.runbook_link("history-latency") == f"{d.RUNBOOKS}history-latency.md"
    assert r.runbook_link("session-save-errors") == d.RUNBOOK_INDEX


def test_local_route_is_the_local_environment_only() -> None:
    assert r.route("local")["object_matchers"][1] == ["environment", "=~", "local"]
    assert r.contact_point("local", r.LOCAL_URL)["settings"]["url"].endswith(d.DISPATCH_PATH)


def test_the_template_copies_only_named_labels_and_annotations() -> None:
    """Never all labels or annotations: only what the contract names."""
    text = template()
    assert set(re.findall(r"\.Labels\.(\w+)", text)) == {"environment", "alert", "alertname"}
    assert set(re.findall(r"\.Annotations\.(\w+)", text)) == {"summary", "description"}
    assert not re.search(r"\.(Labels|Annotations)\b(?!\.)", text)
    assert not re.search(r"\.(Common|Group)(Labels|Annotations)|\.Values|\.ValueString", text)


def test_the_template_builds_the_whole_contract() -> None:
    text = template()
    assert f'"event_type" "{d.EVENT_TYPE}"' in text
    for name in (*d.FIELDS, *d.LINKS):
        assert f'"{name}" ' in text, name
    assert "data.ToJSON" in text  # every value JSON-escaped, never pasted in by hand


@pytest.mark.parametrize("env", (*d.DEPLOYED, "local"))
@pytest.mark.parametrize("alert", d.ALERTS)
@pytest.mark.parametrize("status", d.STATUSES)
def test_a_synthetic_alert_says_what_its_rule_says(alert: str, env: str, status: str) -> None:
    """`verify` and `test` send it through the check, which pins the text to the rule
    (#212): the rule's title and summary, and its description with zero in every slot."""
    sample = r.synthetic_alert("https://example.test/", env, alert, status)
    text = d.rule_text(alert, env)
    assert text is not None
    assert sample["labels"]["alertname"] == text.title
    assert sample["annotations"]["summary"] == text.summary
    assert text.description.fullmatch(sample["annotations"]["description"])
    zero = "0% of the 0 sessions" if alert == "session-save-errors" else "percentile of the 0 "
    assert zero in sample["annotations"]["description"]


@pytest.mark.parametrize("alert", d.ALERTS)
def test_the_traces_link_opens_the_alerts_requests(alert: str) -> None:
    assert r.TRACES[alert] in template()
    assert g._traceql("%s", r.TRACES[alert]) in template()


def test_the_cloud_template_uses_grafana_clouds_traces() -> None:
    assert '"uid" "grafanacloud-traces"' in template()
    assert '"uid" "tempo"' in r.payload_template("tempo")


def test_merged_policy_keeps_every_other_route() -> None:
    other = {"receiver": "grafana-default-email", "object_matchers": [["team", "=", "x"]]}
    stale = {"receiver": r.CONTACT_POINT, "object_matchers": []}
    tree = {
        "receiver": "grafana-default-email",
        "group_by": ["alertname"],
        "routes": [other, stale],
    }
    merged = r.merged_policy(tree, r.route("cloud"))
    assert merged["routes"] == [r.route("cloud"), other]
    assert merged["receiver"] == "grafana-default-email"
    assert r.merged_policy({"receiver": "x"}, r.route("cloud"))["routes"] == [r.route("cloud")]


class FakeGrafana:
    def __init__(self, existing: bool) -> None:
        self.points = [{"uid": r.CONTACT_POINT, "settings": {}}] if existing else []
        self.calls: list[tuple[str, str, Any]] = []

    def __call__(
        self, grafana: str, token: str | None, method: str, api: str, body: Any = None
    ) -> Any:
        self.calls.append((method, api, body))
        if api == "/api/datasources":
            return [
                {"uid": "grafanacloud-traces", "type": "tempo", "name": "grafanacloud-x-traces"}
            ]
        if api == "/api/v1/provisioning/contact-points" and method == "GET":
            return self.points
        if api == "/api/v1/provisioning/policies" and method == "GET":
            return {"receiver": "grafana-default-email"}
        return None


def test_apply_creates_the_contact_point_with_the_token(
    monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
) -> None:
    fake = FakeGrafana(existing=False)
    monkeypatch.setattr(r, "call", fake)
    r.apply("https://grafana.example", "cloud", "sa-token", "dispatch-token", r.DISPATCH_URL)
    posts = [b for m, a, b in fake.calls if m == "POST"]
    assert posts[0]["settings"]["authorization_credentials"] == "dispatch-token"
    assert posts[0]["settings"]["url"] == r.DISPATCH_URL
    (policy,) = [b for m, a, b in fake.calls if m == "PUT" and a.endswith("/policies")]
    assert policy["routes"] == [r.route("cloud")]
    out = capsys.readouterr().out
    assert "dispatch-token" not in out and "sa-token" not in out


def test_apply_keeps_the_stored_token_when_none_is_given(monkeypatch: pytest.MonkeyPatch) -> None:
    fake = FakeGrafana(existing=True)
    monkeypatch.setattr(r, "call", fake)
    r.apply("https://grafana.example", "cloud", "sa-token", "", r.DISPATCH_URL)
    (put,) = [b for m, a, b in fake.calls if m == "PUT" and "contact-points" in a]
    assert put["settings"]["authorization_credentials"] == "[REDACTED]"


def test_apply_refuses_a_new_contact_point_without_a_token(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(r, "call", FakeGrafana(existing=False))
    with pytest.raises(RuntimeError, match="needs the token"):
        r.apply("https://grafana.example", "cloud", "sa-token", "", r.DISPATCH_URL)


@pytest.mark.parametrize(
    "url", ["http://ineedtofocus.grafana.net", "ineedtofocus.grafana.net", "ftp://x", "https://"]
)
@pytest.mark.parametrize("command", ["apply", "test"])
def test_cloud_refuses_anything_but_https(
    url: str, command: str, monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
) -> None:
    """Neither token may cross the network in clear; the URL is checked before either
    token is even asked for."""

    def no_prompt(prompt: str) -> str:
        raise AssertionError("asked for a token")

    monkeypatch.setattr("getpass.getpass", no_prompt)
    extra = ["--env", "dev", "--alert", "session-save-errors"] if command == "test" else []
    assert r.main([command, "cloud", "--grafana", url, *extra]) == 2
    assert "https://" in capsys.readouterr().err
    with pytest.raises(RuntimeError, match="https://"):
        r.apply(url, "cloud", "sa-token", "dispatch-token", r.DISPATCH_URL)
    with pytest.raises(RuntimeError, match="https://"):
        r.send_test(url, "sa-token", "cloud", "dev", "session-save-errors")


@pytest.mark.parametrize("url", ["http://grafana.example", "https://10.0.0.5:3000"])
def test_local_refuses_anything_but_this_machine(url: str, monkeypatch: pytest.MonkeyPatch) -> None:
    """`apply local` sends the stand-in token in the contact point: only to a local Grafana."""
    monkeypatch.setattr("getpass.getpass", lambda prompt: "stand-in")
    assert r.main(["apply", "local", "--grafana", url]) == 2
    assert r.check_grafana_url("local", "http://127.0.0.1:3005/") == "http://127.0.0.1:3005"
    assert r.check_grafana_url("cloud", "https://x.grafana.net/") == "https://x.grafana.net"


def test_a_redirect_is_never_followed_with_the_token() -> None:
    """A real server answers 302 to a second address; neither the Authorization header nor
    a body holding the dispatch token may reach it."""
    import http.server
    import threading

    seen: list[str] = []

    class Handler(http.server.BaseHTTPRequestHandler):
        def _any(self) -> None:
            length = int(self.headers.get("Content-Length") or 0)
            body = self.rfile.read(length).decode()
            seen.append(f"{self.command} {self.path} {self.headers.get('Authorization')} {body}")
            self.send_response(302)
            self.send_header("Location", f"http://127.0.0.1:{port}/elsewhere")
            self.end_headers()

        do_GET = do_POST = do_PUT = _any

        def log_message(self, *args: Any) -> None:
            pass

    server = http.server.HTTPServer(("127.0.0.1", 0), Handler)
    port = server.server_address[1]
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    try:
        with pytest.raises(RuntimeError, match=r"302 redirect .* not followed"):
            r.call(f"http://127.0.0.1:{port}", "tok", "GET", "/api/datasources")
        with pytest.raises(RuntimeError, match=r"302 redirect .* not followed"):
            r.call(
                f"http://127.0.0.1:{port}",
                "tok",
                "POST",
                "/api/v1/provisioning/contact-points",
                {"settings": {"authorization_credentials": "dispatch-token"}},
            )
        # The namespace lookup (#219) is the first request `test` makes.
        with pytest.raises(RuntimeError, match=r"/api/frontend/settings -> HTTP 302 redirect"):
            r.send_test(f"http://127.0.0.1:{port}", "tok", "local", "local", "history-latency")
    finally:
        server.shutdown()
        server.server_close()
    assert len(seen) == 3
    assert not [s for s in seen if "/elsewhere" in s]  # never followed
    assert seen[0].startswith("GET /api/datasources Bearer tok")
    assert seen[2].startswith("GET /api/frontend/settings Bearer tok")


# --- The receivers API's namespace (#219) ------------------------------------------------

CLOUD = "https://ineedtofocus.grafana.net"
RECEIVER = "Zm9jdXMtb25jYWxsLWdpdGh1Yg"  # how Grafana names a receiver: its name, base64url
TEST_CLOUD = ["test", "cloud", "--grafana", CLOUD, "--env", "dev", "--alert", "session-save-errors"]


class FakeOpener:
    """Stands in for #33's no-redirect opener, so every request goes through the real
    call(): records each request and answers like Grafana's API. `settings` is what
    /api/frontend/settings returns."""

    def __init__(self, settings: Any) -> None:
        self.settings = settings
        self.requests: list[urllib.request.Request] = []

    def open(self, req: urllib.request.Request, timeout: float) -> io.BytesIO:
        self.requests.append(req)
        path = urllib.parse.urlsplit(req.full_url).path
        answer: Any
        if path == "/api/frontend/settings":
            answer = self.settings
        elif path.endswith("/receivers"):
            integration = {
                "uid": r.CONTACT_POINT,
                "type": "webhook",
                "version": "v1",
                "settings": {"url": r.DISPATCH_URL},
                "secureFields": {"authorization_credentials": True},
            }
            item = {"metadata": {"name": RECEIVER}, "spec": {"integrations": [integration]}}
            answer = {"items": [item]}
        elif path.endswith(f"/receivers/{RECEIVER}/test"):
            answer = {"status": "success"}
        else:
            raise AssertionError(f"unexpected request {req.get_method()} {req.full_url}")
        return io.BytesIO(json.dumps(answer).encode())

    def urls(self) -> list[str]:
        return [f"{q.get_method()} {q.full_url}" for q in self.requests]


def run_test_cloud(
    monkeypatch: pytest.MonkeyPatch, settings: Any, *extra: str
) -> tuple[int, FakeOpener]:
    """`alert_routing.py test cloud …` against a fake Grafana Cloud."""
    opener = FakeOpener(settings)
    monkeypatch.setattr(ga, "_OPENER", opener)
    monkeypatch.setattr("getpass.getpass", lambda prompt: "sa-token")
    return r.main([*TEST_CLOUD, *extra]), opener


def test_test_cloud_uses_the_namespace_grafana_names(
    monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
) -> None:
    """Grafana Cloud's namespace is `stacks-<stack id>`, and `default` gets 403 "invalid
    namespace" there. The receivers API is called in the one the frontend settings name."""
    code, opener = run_test_cloud(monkeypatch, {"namespace": "stacks-123", "appUrl": CLOUD})
    assert code == 0
    api = f"{CLOUD}/apis/notifications.alerting.grafana.app/v1beta1/namespaces/stacks-123"
    assert opener.urls() == [
        f"GET {CLOUD}/api/frontend/settings",
        f"GET {api}/receivers",
        f"POST {api}/receivers/{RECEIVER}/test",
    ]
    out = capsys.readouterr().out
    assert "through focus-oncall-github (stacks-123)" in out and "sa-token" not in out


def test_the_grafana_token_only_goes_to_the_grafana_it_was_given_for(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """The lookup goes through call(), like every other request: https, the --grafana
    host, and never a redirect (test_a_redirect_is_never_followed_with_the_token)."""
    code, opener = run_test_cloud(monkeypatch, {"namespace": "stacks-123"})
    assert code == 0
    assert len(opener.requests) == 3
    for req in opener.requests:
        parts = urllib.parse.urlsplit(req.full_url)
        assert (parts.scheme, parts.netloc) == ("https", "ineedtofocus.grafana.net")
        assert req.get_header("Authorization") == "Bearer sa-token"


@pytest.mark.parametrize("settings", [{}, {"namespace": ""}, {"namespace": None}, None])
def test_test_falls_back_to_the_default_namespace(
    settings: Any, monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
) -> None:
    code, opener = run_test_cloud(monkeypatch, settings)
    assert code == 0
    assert "/namespaces/default/receivers" in opener.urls()[1]
    assert "names no namespace: using 'default'" in capsys.readouterr().out


def test_the_namespace_flag_skips_the_lookup(monkeypatch: pytest.MonkeyPatch) -> None:
    code, opener = run_test_cloud(monkeypatch, {"namespace": "stacks-123"}, "--namespace", "org-2")
    assert code == 0
    urls = opener.urls()
    assert not [u for u in urls if "frontend/settings" in u]
    assert [u.split("/namespaces/")[1].split("/")[0] for u in urls] == ["org-2", "org-2"]


@pytest.mark.parametrize(
    "bad", ["", "../default", "stacks-1/receivers", "x?y=1", "a b", "Stacks-1", "-x", "a.b"]
)
def test_a_namespace_that_could_change_the_request_is_refused(
    bad: str, monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
) -> None:
    """From --namespace: refused before the token is asked for. From Grafana's settings:
    refused before the receivers API is called."""

    def no_prompt(prompt: str) -> str:
        raise AssertionError("asked for a token")

    monkeypatch.setattr("getpass.getpass", no_prompt)
    assert r.main([*TEST_CLOUD, "--namespace", bad]) == 2
    assert "isn't a Grafana namespace" in capsys.readouterr().err
    if bad:  # an empty namespace in the settings is the fallback case
        code, opener = run_test_cloud(monkeypatch, {"namespace": bad})
        assert code == 1
        assert opener.urls() == [f"GET {CLOUD}/api/frontend/settings"]
        assert "isn't a Grafana namespace" in capsys.readouterr().err


def test_the_namespace_flag_is_for_test_only() -> None:
    assert r.main(["apply", "local", "--namespace", "default"]) == 2


def test_no_api_path_hardcodes_a_namespace() -> None:
    """Every Kubernetes-style /apis/... path takes the namespace it's given (#219)."""
    source = (REPO / "scripts" / "alert_routing.py").read_text()
    assert re.findall(r"/namespaces/[^{]", source) == []
    assert "/namespaces/{namespace}" in r.RECEIVERS_API


def test_apply_cloud_needs_the_grafana_url() -> None:
    assert r.main(["apply", "cloud"]) == 2
    assert r.main(["apply", "staging", "--grafana", "https://x"]) == 2


# --- The receiving workflow ---------------------------------------------------------------


@pytest.fixture(scope="module")
def workflow() -> dict[Any, Any]:
    data: dict[Any, Any] = yaml.safe_load(WORKFLOW.read_text())
    return data


def test_the_workflow_is_woken_by_the_dispatch_only(workflow: dict[Any, Any]) -> None:
    triggers = workflow.get("on", workflow.get(True))
    assert triggers == {"repository_dispatch": {"types": [d.EVENT_TYPE]}}


def test_the_check_job_holds_no_credential(workflow: dict[Any, Any]) -> None:
    """The check runs first, with no secret and no environment. The agent jobs after it
    (#35, scripts/tests/test_oncall_workflow.py) hold the `oncall` environment's secrets."""
    assert workflow["permissions"] == {}
    assert next(iter(workflow["jobs"])) == "alert"
    job = workflow["jobs"]["alert"]
    assert job["permissions"] == {"contents": "read"}
    assert "secrets." not in yaml.safe_dump(job)
    assert "environment" not in job
    for name, other in workflow["jobs"].items():
        if "secrets." in yaml.safe_dump(other):
            assert other["environment"]["name"] == "oncall", name


def test_the_workflow_checks_the_payload_without_injection(workflow: dict[Any, Any]) -> None:
    """The payload reaches the check through $GITHUB_EVENT_PATH, never `${{ }}` in a script,
    and the agent starts only after the check passed."""
    job = workflow["jobs"]["alert"]
    runs = [step["run"] for step in job["steps"] if "run" in step]
    assert runs == ['python3 scripts/alert_dispatch.py check-event "$GITHUB_EVENT_PATH"']
    for other in workflow["jobs"].values():
        assert not [s["run"] for s in other["steps"] if "${{" in str(s.get("run", ""))]
    assert workflow["jobs"]["incident"]["needs"] == "alert"
