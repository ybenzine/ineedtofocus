#!/usr/bin/env python3
"""The on-call workflow's own logic (#35): what the agents get, and what they may ask for.

    python3 scripts/oncall.py prepare <event.json> <issues.json> <out dir>
        # check the dispatch again, find the open incident issue, write the on-call agent's
        # alert.json and prompt.md; GITHUB_OUTPUT: alert, environment, status, incident
    python3 scripts/oncall.py decision <out dir>
        # read the agent's decision.json and check it; GITHUB_OUTPUT: action, incident,
        # rollback_env, rollback_tag, pr (an invalid decision becomes `escalate`, exit 1)
    python3 scripts/oncall.py check-pr <pr.json> <incident>
        # the fix PR the reviewer will review: open, from oncall/<incident>-<slug>, on main
    python3 scripts/oncall.py review-prompt <out dir> <pr> <incident>
    python3 scripts/oncall.py review-result <out dir>
        # the reviewer session's review.json; GITHUB_OUTPUT: review=<verdict>/<posted>
    python3 scripts/oncall.py follow-up-prompt <out dir> --action rollback|fix --incident <n>
        --alert <alert> --environment <env> [--pr <n>] [--review <verdict>/<posted>]
        [--rollback-result <result>] [--rollback-run <url>] [--rollback-tag <sha>]
    python3 scripts/oncall.py stalled-body <alert.json> <run url>
        # the `⛔ Needs Yacine:` the workflow posts when the agent's session didn't finish

.github/workflows/oncall.yml runs these between the agent sessions, so what crosses from
an agent to a job that holds more power (the rollback job's `actions: write`) is a
checked value, never free text. The prompts are the Markdown templates in
scripts/oncall_prompts/. The on-call agent's prompt carries only the payload fields whose
values are fixed words, the rules' pinned title and summary, or timestamps. The rule's
free-text `description` stays out until #212 pins it, and so do the Grafana links: the
agent reads the numbers itself with scripts/oncall_grafana.py. Stdlib only.
"""

from __future__ import annotations

import json
import os
import re
import string
import sys
from pathlib import Path
from typing import Any

import alert_dispatch as d

PROMPTS = Path(__file__).resolve().parent / "oncall_prompts"
RUNBOOKS = "_docs/runbooks"
ACTIONS = ("none", "rollback", "fix", "escalate")
SHA = re.compile(r"[0-9a-f]{40}")
NUMBER = re.compile(r"[1-9][0-9]{0,8}")
# The people and bots whose words on GitHub the agents may act on. On a public repo anyone
# can comment; everyone else's text is data.
TRUSTED_AUTHORS = (
    "ybenzine",
    "merciful-poseidon",
    "github-actions[bot]",
    "ineedtofocus-reviewer[bot]",
)
# What the agent sees of the dispatch: no free text, no links (see the module docstring).
AGENT_FIELDS = ("alert", "environment", "status", "title", "summary", "started_at", "resolved_at")
VERDICTS = ("approve", "request-changes")
POSTED = ("app", "fallback", "failed")
REVIEWS = ("unknown", *(f"{v}/{p}" for v in VERDICTS for p in POSTED))
RUN_URL = re.compile(rf"https://github\.com/{re.escape(d.REPOSITORY)}/actions/runs/[0-9]+")
RUN_RESULTS = ("success", "failure", "not-found")


class Invalid(Exception):
    pass


def render(name: str, **values: Any) -> str:
    """A prompt template with every `${name}` filled in; a missing value is an error."""
    return string.Template((PROMPTS / f"{name}.md").read_text()).substitute(values)


def untrusted_github() -> str:
    authors = ", ".join(f"`{a}`" for a in TRUSTED_AUTHORS)
    return render("untrusted-github", authors=authors).strip()


def incident_title(payload: dict[str, Any]) -> str:
    """`Incident: <the rule's title>`, e.g. `Incident: Session saves failing (prod)`."""
    return f"Incident: {payload['title']}"


def find_incident(issues: list[dict[str, Any]], title: str) -> int | None:
    """The newest open issue labelled type:incident with exactly that title. Adding a label
    takes triage access, so an outsider's issue with the same title isn't picked."""
    found = [
        int(i["number"])
        for i in issues
        if str(i.get("state", "OPEN")).upper() == "OPEN"
        and i.get("title") == title
        and "type:incident" in {label.get("name") for label in i.get("labels") or []}
    ]
    return max(found) if found else None


def agent_alert(payload: dict[str, Any], incident: int | None) -> dict[str, Any]:
    view = {k: payload[k] for k in AGENT_FIELDS}
    view["runbook"] = f"{RUNBOOKS}/{payload['alert']}.md"
    view["incident_issue"] = incident
    view["incident_title"] = incident_title(payload)
    return view


def respond_prompt(alert: dict[str, Any], can_open_prs: bool) -> str:
    env, incident = alert["environment"], alert["incident_issue"]
    if incident:
        issue = (
            f"An open incident issue already exists for this alert: #{incident}. "
            "Update it; don't open another."
        )
    else:
        issue = (
            "There is no open incident issue for this alert yet. Open one titled exactly "
            f"`{alert['incident_title']}`, with the labels `type:incident` and `agent:oncall`."
        )
    if alert["status"] == "firing":
        fix = render("fix-pr" if can_open_prs else "fix-patch").rstrip("\n")
        todo = render("firing", issue=issue, env=env, fix=fix)
    else:
        todo = render("resolved", issue=issue, env=env)
    alert_json = "```json\n" + json.dumps(alert, indent=2, sort_keys=True) + "\n```"
    return render(
        "respond",
        runbook=alert["runbook"],
        alert_json=alert_json,
        untrusted_github=untrusted_github(),
        env=env,
        status=alert["status"],
        todo=todo.rstrip("\n"),
    )


def _write_outputs(values: dict[str, Any]) -> None:
    lines = [f"{k}={'' if v is None else v}\n" for k, v in values.items()]
    for line in lines:
        if "\n" in line[:-1]:
            raise ValueError(f"an output must be one line: {line!r}")
    path = os.environ.get("GITHUB_OUTPUT")
    if path:
        with open(path, "a") as f:
            f.writelines(lines)
    else:
        sys.stdout.writelines(lines)


def prepare(event_path: str, issues_path: str, out: str) -> int:
    event = json.loads(Path(event_path).read_text())
    found = d.event_problems(event)
    if found:
        for problem in found:
            print(f"::error title=Invalid alert dispatch::{json.dumps(problem)}")
        return 1
    payload = event["client_payload"]
    issues = json.loads(Path(issues_path).read_text() or "[]")
    incident = find_incident(issues, incident_title(payload))
    alert = agent_alert(payload, incident)
    can_open_prs = os.environ.get("ONCALL_CAN_OPEN_PRS") == "true"
    out_dir = Path(out)
    out_dir.mkdir(parents=True, exist_ok=True)
    (out_dir / "alert.json").write_text(json.dumps(alert, indent=2, sort_keys=True) + "\n")
    (out_dir / "prompt.md").write_text(respond_prompt(alert, can_open_prs))
    _write_outputs(
        {
            "alert": payload["alert"],
            "environment": payload["environment"],
            "status": payload["status"],
            "incident": incident or "",
        }
    )
    print(
        f"ok    {payload['alert']} {payload['status']} in {payload['environment']}; "
        f"incident {'#' + str(incident) if incident else 'none yet'}"
    )
    return 0


def _number(value: Any, name: str) -> int:
    if isinstance(value, bool) or not isinstance(value, (int, str)):
        raise Invalid(f"{name} is not a number")
    if not NUMBER.fullmatch(str(value)):
        raise Invalid(f"{name} {str(value)[:20]!r} is not an issue or PR number")
    return int(value)


def check_decision(raw: Any, alert: dict[str, Any]) -> dict[str, Any]:
    """The decision as outputs, or Invalid. A rollback is of the alert's own environment,
    only while it fires; a fix names its PR."""
    if not isinstance(raw, dict):
        raise Invalid("decision.json is not an object")
    extra = set(raw) - {"action", "incident", "rollback", "pr"}
    if extra:
        raise Invalid(f"unexpected keys: {', '.join(sorted(extra))}")
    action = raw.get("action")
    if action not in ACTIONS:
        raise Invalid(f"action {str(action)[:20]!r} is not one of {', '.join(ACTIONS)}")
    result: dict[str, Any] = {
        "action": action,
        "incident": _number(raw.get("incident"), "incident"),
        "rollback_env": "",
        "rollback_tag": "",
        "pr": "",
    }
    if action == "rollback":
        if alert["status"] != "firing":
            raise Invalid("a rollback is only for a firing alert")
        rollback = raw.get("rollback") or {}
        if not isinstance(rollback, dict) or set(rollback) - {"tag", "env"}:
            raise Invalid("rollback must be an object with an optional tag")
        env = rollback.get("env", alert["environment"])
        if env != alert["environment"]:
            raise Invalid(f"a rollback is of the alert's environment, {alert['environment']}")
        tag = rollback.get("tag") or ""
        if not isinstance(tag, str) or (tag and not SHA.fullmatch(tag)):
            raise Invalid("rollback.tag must be empty or a 40-character lowercase sha")
        result["rollback_env"], result["rollback_tag"] = env, tag
    if action == "fix":
        result["pr"] = _number(raw.get("pr"), "pr")
    return result


def decision(out: str) -> int:
    out_dir = Path(out)
    alert = json.loads((out_dir / "alert.json").read_text())
    path = out_dir / "decision.json"
    try:
        if not path.is_file():
            raise Invalid("the agent wrote no decision.json")
        try:
            raw = json.loads(path.read_text())
        except json.JSONDecodeError as e:
            raise Invalid(f"decision.json is not JSON: {e.msg}") from None
        result = check_decision(raw, alert)
    except Invalid as e:
        print(f"::error title=Invalid on-call decision::{json.dumps(str(e))}")
        incident = alert.get("incident_issue") or ""
        _write_outputs(
            {
                "action": "escalate",
                "incident": incident,
                "rollback_env": "",
                "rollback_tag": "",
                "pr": "",
            }
        )
        return 1
    _write_outputs(result)
    print(f"ok    decision: {result['action']} for incident #{result['incident']}")
    return 0


def check_pr(pr_path: str, incident: str) -> int:
    """The PR the reviewer step reviews: open, on main, from this incident's branch."""
    pr = json.loads(Path(pr_path).read_text())
    problems = []
    if pr.get("state") != "OPEN":
        problems.append(f"PR #{pr.get('number')} is {pr.get('state')}, not open")
    if pr.get("baseRefName") != "main":
        problems.append("the PR doesn't target main")
    branch = rf"oncall/{re.escape(incident)}-[a-z0-9][a-z0-9-]*"
    if not NUMBER.fullmatch(incident) or not re.fullmatch(branch, pr.get("headRefName", "")):
        problems.append(f"the branch {pr.get('headRefName')!r} isn't oncall/{incident}-<slug>")
    if pr.get("isCrossRepository") is not False:
        problems.append("the PR comes from a fork")
    for problem in problems:
        print(f"::error title=Not the on-call fix PR::{json.dumps(problem)}")
    return 1 if problems else 0


def review_prompt(pr: int, incident: int) -> str:
    return render("review", pr=pr, incident=incident, untrusted_github=untrusted_github())


def review_result(out: str) -> int:
    """The reviewer session's review.json as one checked output: `<verdict>/<posted>`."""
    try:
        raw = json.loads((Path(out) / "review.json").read_text())
        value = f"{raw['verdict']}/{raw['posted']}"
        if value not in REVIEWS[1:]:
            raise ValueError(value)
    except (OSError, ValueError, KeyError, TypeError):
        print("::warning title=No review result::the reviewer session wrote no valid review.json")
        value = "unknown"
    _write_outputs({"review": value})
    return 0


def follow_up_prompt(values: dict[str, str]) -> str:
    """The follow-up session's prompt, from the workflow's checked outputs."""
    action, alert, env = (
        values.get("action", ""),
        values.get("alert", ""),
        values.get("environment", ""),
    )
    if action not in ("rollback", "fix"):
        raise Invalid("a follow-up is for a rollback or a fix")
    if alert not in d.ALERTS or env not in d.DEPLOYED:
        raise Invalid("unknown alert or environment")
    incident = _number(values.get("incident"), "incident")
    if action == "rollback":
        run, result = values.get("rollback_run", ""), values.get("rollback_result", "not-found")
        tag = values.get("rollback_tag", "")
        if run and not RUN_URL.fullmatch(run):
            raise Invalid("--rollback-run is not a run of this repo")
        if result not in RUN_RESULTS:
            raise Invalid(f"--rollback-result is not one of {', '.join(RUN_RESULTS)}")
        if tag and not SHA.fullmatch(tag):
            raise Invalid("--rollback-tag is not a sha")
        body = render(
            "follow-up-rollback",
            env=env,
            alert=alert,
            tag_flag=f" -f tag={tag}" if tag else "",
            rollback_result=result,
            rollback_run=run or "(not found)",
        )
    else:
        review = values.get("review") or "unknown"
        if review not in REVIEWS:
            raise Invalid("--review is not a review result")
        body = render(
            "follow-up-fix",
            pr=_number(values.get("pr"), "pr"),
            review=review,
            alert=alert,
            incident=incident,
        )
    return render(
        "follow-up",
        incident=incident,
        alert=alert,
        env=env,
        action=action,
        runbook=f"{RUNBOOKS}/{alert}.md",
        untrusted_github=untrusted_github(),
        body=body.rstrip("\n"),
    )


def stalled_body(alert: dict[str, Any], run_url: str) -> str:
    """The comment the workflow posts when the agent's session didn't finish."""
    if not RUN_URL.fullmatch(run_url):
        raise Invalid("not a run of this repo")
    return render(
        "stalled",
        alert=alert["alert"],
        status=alert["status"],
        env=alert["environment"],
        incident_title=alert["incident_title"],
        runbook=alert["runbook"],
        run_url=run_url,
    )


def _options(argv: list[str]) -> dict[str, str]:
    if len(argv) % 2:
        raise Invalid("options come in --key value pairs")
    values = {}
    for key, value in zip(argv[::2], argv[1::2], strict=True):
        if not key.startswith("--"):
            raise Invalid(f"not an option: {key}")
        values[key[2:].replace("-", "_")] = value
    return values


def _write(out: str, name: str, text: str) -> int:
    Path(out).mkdir(parents=True, exist_ok=True)
    (Path(out) / name).write_text(text)
    return 0


def main(argv: list[str]) -> int:
    command, args = (argv[0], argv[1:]) if argv else ("", [])
    try:
        if command == "prepare" and len(args) == 3:
            return prepare(*args)
        if command == "decision" and len(args) == 1:
            return decision(args[0])
        if command == "check-pr" and len(args) == 2:
            return check_pr(*args)
        if command == "review-prompt" and len(args) == 3:
            pr, incident = _number(args[1], "pr"), _number(args[2], "incident")
            return _write(args[0], "review-prompt.md", review_prompt(pr, incident))
        if command == "review-result" and len(args) == 1:
            return review_result(args[0])
        if command == "follow-up-prompt" and args:
            return _write(args[0], "follow-up-prompt.md", follow_up_prompt(_options(args[1:])))
        if command == "stalled-body" and len(args) == 2:
            print(stalled_body(json.loads(Path(args[0]).read_text()), args[1]), end="")
            return 0
    except Invalid as e:
        print(f"::error title=on-call::{json.dumps(str(e))}")
        return 1
    print(__doc__, file=sys.stderr)
    return 2


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
