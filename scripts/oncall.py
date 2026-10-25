#!/usr/bin/env python3
"""The on-call workflow's deterministic logic (#35): everything around the Claude sessions.

.github/workflows/oncall.yml runs the agents with read-only tokens. Every write to GitHub
(the incident issue, labels, the fix branch and PR, the review, the merge, the rollback)
is a workflow step that runs this script on a fresh checkout, never inside a session. What
crosses from a session to those steps is a file the step checks: decision.json, a comment,
a review verdict, a git bundle. State passes from one session to the next only through the
checked values in its prompt, never through what an earlier session wrote on the issue.

    incident <event.json> <issues.json> <prs.json> <runs.json> <run id> <out dir>
        # find (or plan) the incident issue, the daily run cap, what the incident already
        # had; GITHUB_OUTPUT: alert, environment, status, incident, create, rolled_back,
        # open_pr, capped, cap_notice, run_agent; writes incident-body.md and cap-body.md
    prompt <event.json> <out dir> --incident <n> --rolled-back <bool> --open-pr <n>
        # the on-call agent's prompt.md and alert.json
    decision <dir> --status <s> --environment <env> --incident <n> --rolled-back <bool>
        --open-pr <n>
        # the agent's decision.json and comment.md, checked; GITHUB_OUTPUT: action,
        # rollback_tag, branch, comment, reason ("stalled" when they don't pass)
    check-fix <branch> <incident>
        # the agent's fix branch, in this checkout: name, base, files, size
    pr-body <pr.md or -> <incident>      # the fix PR's body: `Refs #<n>`, never Closes
    patch-body <branch> <incident>       # the fallback: the fix as a diff, ⛔ Needs Yacine
    review-prompt <out dir> <pr> <incident>
    review-result <dir>                  # GITHUB_OUTPUT: verdict, body
    check-comment <file>                 # a session's comment: there, not empty, not huge
    check-pr <pr.json> <incident>        # the PR the reviewer reviews
    merge-check <pr.json> <incident>     # GITHUB_OUTPUT: ok, reason
    not-merged-body <incident> <pr> <reason> <app|fallback|none>
    merged-body <environment> <incident> <pr> <sha>
    follow-up-prompt <out dir> --key value ...
    stalled-body <alert> <status> <environment> <incident title> <run url> <reason>
    open-fix-pr <prs.json> <incident>    # prints the incident's open on-call PR, if any

The prompts are the Markdown templates in scripts/oncall_prompts/. Stdlib only, plus
alert_dispatch.py and the rules it reads (grafana_alerts.py, grafana_dashboards.py).
"""

from __future__ import annotations

import datetime as dt
import json
import os
import re
import string
import subprocess
import sys
from pathlib import Path
from typing import Any

import alert_dispatch as d

REPO = Path(__file__).resolve().parents[1]
PROMPTS = Path(__file__).resolve().parent / "oncall_prompts"
PROTECTION = REPO / "infra" / "github" / "main-branch-protection.json"
RUNBOOKS = "_docs/runbooks"
ACTIONS = ("none", "rollback", "fix", "escalate")
ROLLED_BACK = "oncall:rolled-back"
SHA = re.compile(r"[0-9a-f]{40}")
NUMBER = re.compile(r"[1-9][0-9]{0,8}")
# The only accounts whose comments may carry instructions: Yacine and the build agents.
# Not this workflow's own bot: what one session wrote must not steer the next.
TRUSTED_AUTHORS = ("ybenzine", "merciful-poseidon")
# What the agent sees of the dispatch. Every value is fixed, pinned to the rule (title,
# summary and, since #212, description) or a timestamp. The links stay out: their query
# strings are free text.
AGENT_FIELDS = (
    "alert",
    "environment",
    "status",
    "title",
    "summary",
    "description",
    "started_at",
    "resolved_at",
)
# Agent runs per alert and environment in 24 hours (firing, repeats and resolution). The
# Anthropic spend limit is the backstop.
DAILY_RUN_CAP = 4
MAX_COMMENT = 20_000
MAX_FIX_FILES = 20
MAX_FIX_LINES = 1000
# A fix may not touch what guards the agents: the workflows (the App can't push them
# anyway), the Claude Code settings and agent definitions, or this workflow's own logic.
PROTECTED_PATHS = ("^\\.github/", "^\\.claude/", "^scripts/oncall", "^infra/github/")
VERDICTS = ("approve", "request-changes")
RUN_URL = re.compile(rf"https://github\.com/{re.escape(d.REPOSITORY)}/actions/runs/[0-9]+")
RUN_RESULTS = ("success", "failure", "skipped-recent", "not-run")
CLOSING = re.compile(r"\b(close[sd]?|fix(e[sd])?|resolve[sd]?)\b(\s*:)?\s+#", re.IGNORECASE)


class Invalid(Exception):
    pass


def render(name: str, **values: Any) -> str:
    """A prompt template with every `${name}` filled in; a missing value is an error."""
    return string.Template((PROMPTS / f"{name}.md").read_text()).substitute(values)


def untrusted_github() -> str:
    authors = " and ".join(f"`{a}`" for a in TRUSTED_AUTHORS)
    return render("untrusted-github", authors=authors).strip()


def _bool(value: str | bool) -> bool:
    if isinstance(value, bool):
        return value
    if value not in ("true", "false"):
        raise Invalid(f"not a boolean: {value!r}")
    return value == "true"


def _number(value: Any, name: str) -> int:
    if isinstance(value, bool) or not isinstance(value, (int, str)):
        raise Invalid(f"{name} is not a number")
    if not NUMBER.fullmatch(str(value)):
        raise Invalid(f"{name} {str(value)[:20]!r} is not an issue or PR number")
    return int(value)


def _optional_number(value: str, name: str) -> int | None:
    return None if value in ("", None) else _number(value, name)


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


def _time(value: str) -> dt.datetime:
    return dt.datetime.fromisoformat(value.replace("Z", "+00:00"))


def _checked_payload(event_path: str) -> dict[str, Any]:
    event = json.loads(Path(event_path).read_text())
    found = d.event_problems(event)
    if found:
        raise Invalid("; ".join(found))
    payload: dict[str, Any] = event["client_payload"]
    return payload


def incident_title(payload: dict[str, Any]) -> str:
    """`Incident: <the rule's title>`, e.g. `Incident: Session saves failing (prod)`."""
    return f"Incident: {payload['title']}"


# --- The incident issue ---------------------------------------------------------------


def _labels(issue: dict[str, Any]) -> set[str]:
    return {str(label.get("name")) for label in issue.get("labels") or []}


def find_incident(issues: list[dict[str, Any]], payload: dict[str, Any]) -> dict[str, Any] | None:
    """The incident this dispatch belongs to. Firing: the newest open issue labelled
    type:incident with exactly the incident title. Resolved: the newest such issue in any
    state, if it is still open or was closed at or after the alert started; a resolution
    never opens a new one. Adding a label takes triage access, so an outsider's issue
    with the same title isn't picked."""
    title = incident_title(payload)
    candidates = [i for i in issues if i.get("title") == title and "type:incident" in _labels(i)]
    candidates.sort(key=lambda i: int(i["number"]), reverse=True)
    for issue in candidates:
        state = str(issue.get("state", "OPEN")).upper()
        if state == "OPEN":
            return issue
        closed = issue.get("closedAt")
        if (
            payload["status"] == "resolved"
            and closed
            and _time(closed) >= _time(payload["started_at"])
        ):
            return issue
    return None


def open_fix_pr(prs: list[dict[str, Any]], incident: int) -> int | None:
    """The open on-call fix PR of the incident: from `oncall/<incident>-…`, in this repo."""
    for pr in prs:
        if (
            str(pr.get("state", "OPEN")).upper() == "OPEN"
            and str(pr.get("headRefName", "")).startswith(f"oncall/{incident}-")
            and pr.get("isCrossRepository") is False
        ):
            return int(pr["number"])
    return None


def runs_today(
    runs: list[dict[str, Any]], payload: dict[str, Any], run_id: str, now: dt.datetime
) -> int:
    """This workflow's earlier runs for the same alert and environment in the last 24 h."""
    pattern = re.compile(
        rf"Alert: {re.escape(payload['alert'])} (firing|resolved) in "
        rf"{re.escape(payload['environment'])}"
    )
    since = now - dt.timedelta(hours=24)
    return sum(
        1
        for r in runs
        if str(r.get("databaseId")) != run_id
        and pattern.fullmatch(str(r.get("displayTitle", "")))
        and _time(str(r["createdAt"])) >= since
    )


def incident(
    event_path: str,
    issues_path: str,
    prs_path: str,
    runs_path: str,
    run_id: str,
    out: str,
    now: dt.datetime | None = None,
) -> int:
    payload = _checked_payload(event_path)
    issues = json.loads(Path(issues_path).read_text() or "[]")
    prs = json.loads(Path(prs_path).read_text() or "[]")
    runs = json.loads(Path(runs_path).read_text() or "[]")
    now = now or dt.datetime.now(dt.UTC)
    found = find_incident(issues, payload)
    number = int(found["number"]) if found else None
    create = found is None and payload["status"] == "firing"
    count = runs_today(runs, payload, run_id, now)
    capped = count >= DAILY_RUN_CAP
    out_dir = Path(out)
    out_dir.mkdir(parents=True, exist_ok=True)
    (out_dir / "incident-body.md").write_text(
        render(
            "incident",
            title=payload["title"],
            alert=payload["alert"],
            env=payload["environment"],
            started_at=payload["started_at"],
            summary=payload["summary"],
            description=payload["description"],
            runbook=f"{RUNBOOKS}/{payload['alert']}.md",
        )
    )
    (out_dir / "cap-body.md").write_text(
        render(
            "capped",
            alert=payload["alert"],
            env=payload["environment"],
            cap=DAILY_RUN_CAP,
            runbook=f"{RUNBOOKS}/{payload['alert']}.md",
        )
    )
    run_agent = not capped and (number is not None or create)
    _write_outputs(
        {
            "alert": payload["alert"],
            "environment": payload["environment"],
            "status": payload["status"],
            "title": incident_title(payload),
            "incident": number or "",
            "create": str(create).lower(),
            "rolled_back": str(found is not None and ROLLED_BACK in _labels(found)).lower(),
            "open_pr": (open_fix_pr(prs, number) if number else None) or "",
            "capped": str(capped).lower(),
            # Post the cap's ⛔ once: on the first run over it, not on every later one.
            "cap_notice": str(count == DAILY_RUN_CAP).lower(),
            "run_agent": str(run_agent).lower(),
        }
    )
    what = f"#{number}" if number else ("a new one" if create else "none (nothing to do)")
    print(
        f"ok    {payload['alert']} {payload['status']} in {payload['environment']}; incident "
        f"{what}; {count} earlier runs in 24 h (cap {DAILY_RUN_CAP})"
    )
    return 0


# --- The on-call agent's prompt -------------------------------------------------------


def agent_alert(
    payload: dict[str, Any], number: int, rolled_back: bool, open_pr: int | None
) -> dict[str, Any]:
    view: dict[str, Any] = {k: payload[k] for k in AGENT_FIELDS}
    view["runbook"] = f"{RUNBOOKS}/{payload['alert']}.md"
    view["incident_issue"] = number
    view["incident_rolled_back"] = rolled_back
    view["incident_open_fix_pr"] = open_pr
    return view


def respond_prompt(alert: dict[str, Any]) -> str:
    env = alert["environment"]
    if alert["status"] == "firing":
        fix = render("fix", incident=alert["incident_issue"]).rstrip("\n")
        todo = render("firing", env=env, fix=fix, incident=alert["incident_issue"])
    else:
        todo = render("resolved", env=env, incident=alert["incident_issue"])
    alert_json = "```json\n" + json.dumps(alert, indent=2, sort_keys=True) + "\n```"
    return render(
        "respond",
        runbook=alert["runbook"],
        alert_json=alert_json,
        untrusted_github=untrusted_github(),
        env=env,
        status=alert["status"],
        incident=alert["incident_issue"],
        todo=todo.rstrip("\n"),
    )


def prompt(event_path: str, out: str, values: dict[str, str]) -> int:
    payload = _checked_payload(event_path)
    number = _number(values.get("incident"), "incident")
    alert = agent_alert(
        payload,
        number,
        _bool(values.get("rolled_back", "false")),
        _optional_number(values.get("open_pr", ""), "open_pr"),
    )
    out_dir = Path(out)
    out_dir.mkdir(parents=True, exist_ok=True)
    (out_dir / "alert.json").write_text(json.dumps(alert, indent=2, sort_keys=True) + "\n")
    (out_dir / "prompt.md").write_text(respond_prompt(alert))
    return 0


# --- The agent's decision -------------------------------------------------------------


def check_decision(raw: Any, context: dict[str, Any]) -> dict[str, Any]:
    """The decision as outputs, or Invalid. `context`: status, environment, incident,
    rolled_back, open_pr, all from the workflow's own outputs, never from the agent."""
    if not isinstance(raw, dict):
        raise Invalid("decision.json is not an object")
    extra = set(raw) - {"action", "rollback", "branch"}
    if extra:
        raise Invalid(f"unexpected keys: {', '.join(sorted(extra))}")
    action = raw.get("action")
    if action not in ACTIONS:
        raise Invalid(f"action {str(action)[:20]!r} is not one of {', '.join(ACTIONS)}")
    result: dict[str, Any] = {"action": action, "rollback_tag": "", "branch": ""}
    if action in ("rollback", "fix") and context["status"] != "firing":
        raise Invalid(f"a {action} is only for a firing alert")
    if action == "rollback":
        if context["rolled_back"]:
            raise Invalid(
                f"incident #{context['incident']} already had its rollback ({ROLLED_BACK})"
            )
        rollback = raw.get("rollback") or {}
        if not isinstance(rollback, dict) or set(rollback) - {"tag"}:
            raise Invalid("rollback must be an object with an optional tag")
        tag = rollback.get("tag") or ""
        if not isinstance(tag, str) or (tag and not SHA.fullmatch(tag)):
            raise Invalid("rollback.tag must be empty or a 40-character lowercase sha")
        result["rollback_tag"] = tag
    if action == "fix":
        if context["open_pr"]:
            raise Invalid(
                f"incident #{context['incident']} already has fix PR #{context['open_pr']}"
            )
        branch = raw.get("branch")
        if not isinstance(branch, str) or not re.fullmatch(
            rf"oncall/{context['incident']}-[a-z0-9][a-z0-9-]{{0,50}}", branch
        ):
            raise Invalid(f"branch must be oncall/{context['incident']}-<slug>")
        result["branch"] = branch
    return result


def check_comment(path: Path) -> None:
    if not path.is_file():
        raise Invalid("the agent wrote no comment.md")
    text = path.read_text()
    if not text.strip():
        raise Invalid("comment.md is empty")
    if len(text) > MAX_COMMENT:
        raise Invalid(f"comment.md is longer than {MAX_COMMENT} characters")


def decision(directory: str, values: dict[str, str]) -> int:
    context = {
        "status": values.get("status"),
        "environment": values.get("environment"),
        "incident": _number(values.get("incident"), "incident"),
        "rolled_back": _bool(values.get("rolled_back", "false")),
        "open_pr": _optional_number(values.get("open_pr", ""), "open_pr"),
    }
    if context["status"] not in d.STATUSES or context["environment"] not in d.DEPLOYED:
        raise Invalid("bad status or environment")
    base = Path(directory)
    try:
        path = base / "decision.json"
        if not path.is_file():
            raise Invalid("the agent wrote no decision.json (it may have hit a cap or failed)")
        try:
            raw = json.loads(path.read_text())
        except json.JSONDecodeError as e:
            raise Invalid(f"decision.json is not JSON: {e.msg}") from None
        result = check_decision(raw, context)
        check_comment(base / "comment.md")
    except Invalid as e:
        print(f"::error title=On-call decision refused::{json.dumps(str(e))}")
        _write_outputs(
            {"action": "stalled", "rollback_tag": "", "branch": "", "reason": _one_line(str(e))}
        )
        return 0
    _write_outputs({**result, "reason": ""})
    print(f"ok    decision: {result['action']} for incident #{context['incident']}")
    return 0


def _one_line(text: str) -> str:
    return " ".join(text.split())[:300]


# --- The fix branch -------------------------------------------------------------------


def _git(*args: str) -> str:
    return subprocess.run(["git", *args], check=True, capture_output=True, text=True).stdout


def check_fix(branch: str, number: str) -> list[str]:
    """Problems with the agent's fix branch (fetched from its bundle into this checkout)."""
    problems = []
    if not re.fullmatch(rf"oncall/{re.escape(number)}-[a-z0-9][a-z0-9-]{{0,50}}", branch):
        return [f"branch {branch!r} isn't oncall/{number}-<slug>"]
    try:
        _git("merge-base", "--is-ancestor", "origin/main", branch)
    except subprocess.CalledProcessError:
        problems.append("the branch isn't based on origin/main")
    commits = _git("rev-list", "--count", f"origin/main..{branch}").strip()
    if commits == "0":
        problems.append("the branch has no commits")
    files = [f for f in _git("diff", "--name-only", f"origin/main...{branch}").splitlines() if f]
    for f in files:
        if any(re.search(p, f) for p in PROTECTED_PATHS):
            problems.append(f"the fix may not change {f}")
    if len(files) > MAX_FIX_FILES:
        problems.append(f"the fix changes {len(files)} files (at most {MAX_FIX_FILES})")
    lines = 0
    for row in _git("diff", "--numstat", f"origin/main...{branch}").splitlines():
        added, removed, _ = row.split("\t", 2)
        lines += int(added) + int(removed) if added.isdigit() and removed.isdigit() else 0
    if lines > MAX_FIX_LINES:
        problems.append(f"the fix changes {lines} lines (at most {MAX_FIX_LINES})")
    if not any(re.search(r"(^|/)tests?/|(^|/)test_[^/]*\.py$|\.test\.tsx?$", f) for f in files):
        problems.append("the fix has no test file (a regression test comes with it)")
    return problems


def pr_body(text: str, number: int) -> str:
    """The fix PR's body: the agent's text with closing keywords disarmed, and `Refs`.
    The incident closes when the alert resolves, not when the fix reaches dev."""
    disarmed = CLOSING.sub(lambda m: f"{m.group(1)} (ref) #", text.strip())
    return f"{disarmed}\n\nRefs #{number}\n\nOpened by the on-call workflow (#35).\n"


def patch_body(branch: str, number: str) -> str:
    diff = _git("diff", f"origin/main...{branch}")
    if len(diff) > MAX_COMMENT - 2000:
        diff = diff[: MAX_COMMENT - 2000] + "\n… (cut; the whole patch is in the run's artifact)\n"
    return render("patch", incident=number, branch=branch, diff=diff.replace("```", "`​``"))


# --- Review and merge -----------------------------------------------------------------


def review_prompt(pr: int, incident_number: int) -> str:
    return render("review", pr=pr, incident=incident_number, untrusted_github=untrusted_github())


def review_result(directory: str) -> int:
    """The reviewer session's verdict and body, checked: GITHUB_OUTPUT verdict, body."""
    base = Path(directory)
    try:
        raw = json.loads((base / "review.json").read_text())
        verdict = raw["verdict"]
        if verdict not in VERDICTS or set(raw) != {"verdict"}:
            raise ValueError(verdict)
        body = base / "review.md"
        check_comment(body)
        last = [line for line in body.read_text().splitlines() if line.strip()][-1]
        expected = (
            "**Verdict: Approve**" if verdict == "approve" else "**Verdict: Request changes**"
        )
        if last.strip() != expected:
            raise ValueError("the body's verdict line doesn't match review.json")
    except (OSError, ValueError, KeyError, TypeError, IndexError, Invalid) as e:
        print(f"::warning title=No review::the reviewer session left no valid review ({e})")
        _write_outputs({"verdict": "", "body": ""})
        return 0
    _write_outputs({"verdict": verdict, "body": str(body)})
    return 0


def required_checks() -> list[str]:
    data = json.loads(PROTECTION.read_text())
    return [c["context"] for c in data["required_status_checks"]["checks"]]


def merge_check(pr: dict[str, Any], number: int) -> str:
    """Why the fix PR can't merge, or "" when it can: open, this incident's branch, approved
    (the reviewer App's review), every required check passed."""
    if pr.get("state") != "OPEN":
        return f"PR #{pr.get('number')} is {pr.get('state')}"
    if not str(pr.get("headRefName", "")).startswith(f"oncall/{number}-"):
        return "it isn't this incident's on-call branch"
    if pr.get("reviewDecision") != "APPROVED":
        return f"it isn't approved (reviewDecision {pr.get('reviewDecision') or 'none'})"
    results = {
        str(c.get("name") or c.get("context")): str(c.get("conclusion") or c.get("state") or "")
        for c in pr.get("statusCheckRollup") or []
    }
    for name in required_checks():
        if results.get(name, "").upper() != "SUCCESS":
            return f"the required check {name!r} is {results.get(name) or 'missing'}"
    return ""


def check_pr(pr: dict[str, Any], number: int) -> list[str]:
    """The PR the reviewer reviews: open, on main, this incident's branch, not a fork."""
    problems = []
    if pr.get("state") != "OPEN":
        problems.append(f"PR #{pr.get('number')} is {pr.get('state')}, not open")
    if pr.get("baseRefName") != "main":
        problems.append("the PR doesn't target main")
    branch = rf"oncall/{number}-[a-z0-9][a-z0-9-]{{0,50}}"
    if not re.fullmatch(branch, str(pr.get("headRefName", ""))):
        problems.append(f"the branch {pr.get('headRefName')!r} isn't oncall/{number}-<slug>")
    if pr.get("isCrossRepository") is not False:
        problems.append("the PR comes from a fork")
    return problems


NOT_MERGED_WHY = {
    "fallback": "The reviewer App key is unavailable to this workflow (`REVIEWER_APP_KEY` in "
    "the `oncall` environment), so the review was posted as a comment, which can't approve.",
    "app": "The reviewer App posted the review.",
}


def not_merged_body(number: int, pr: int, reason: str, posted: str) -> str:
    why = NOT_MERGED_WHY.get(posted, "No review was posted: the reviewer session didn't finish.")
    return render("not-merged", incident=number, pr=pr, reason=_one_line(reason), why=why)


def merged_body(env: str, number: int, pr: int, sha: str) -> str:
    if not SHA.fullmatch(sha):
        raise Invalid("not a merge sha")
    return render(f"merged-{env}", incident=number, pr=pr, sha=sha)


# --- Follow-up and stalled ------------------------------------------------------------


def follow_up_prompt(values: dict[str, str]) -> str:
    """The follow-up session's prompt, from the workflow's checked outputs only."""
    action, alert, env = (
        values.get("action", ""),
        values.get("alert", ""),
        values.get("environment", ""),
    )
    if action not in ("rollback", "fix"):
        raise Invalid("a follow-up is for a rollback or a fix")
    if alert not in d.ALERTS or env not in d.DEPLOYED:
        raise Invalid("unknown alert or environment")
    number = _number(values.get("incident"), "incident")
    resolved = values.get("resolved", "not-checked")
    if resolved not in ("true", "false", "not-checked"):
        raise Invalid("--resolved is true, false or not-checked")
    journey = values.get("journey", "") or "{}"
    try:
        numbers = json.loads(journey)
    except json.JSONDecodeError:
        raise Invalid("--journey is not JSON") from None
    if not isinstance(numbers, dict) or not all(
        isinstance(v, (int, float, type(None)))
        for k, v in numbers.items()
        if k not in ("environment", "window", "note")
    ):
        raise Invalid("--journey holds more than numbers")
    if action == "rollback":
        run, result = values.get("rollback_run", ""), values.get("rollback_result", "not-run")
        tag = values.get("rollback_tag", "")
        if run and not RUN_URL.fullmatch(run):
            raise Invalid("--rollback-run is not a run of this repo")
        if result not in RUN_RESULTS:
            raise Invalid(f"--rollback-result is not one of {', '.join(RUN_RESULTS)}")
        if tag and not SHA.fullmatch(tag):
            raise Invalid("--rollback-tag is not a sha")
        facts: dict[str, Any] = {
            "rollback_run": run or None,
            "rollback_result": result,
            "rollback_tag": tag or "the last known-good release",
        }
    else:
        merged = values.get("merged", "false")
        sha = values.get("merge_sha", "")
        if merged not in ("true", "false") or (sha and not SHA.fullmatch(sha)):
            raise Invalid("--merged/--merge-sha")
        facts = {
            "pr": _number(values.get("pr"), "pr"),
            "review": values.get("review") if values.get("review") in VERDICTS else "none",
            "review_posted_as": values.get("posted")
            if values.get("posted") in ("app", "fallback")
            else "none",
            "merged": merged == "true",
            "merge_sha": sha or None,
            "not_merged_because": _one_line(values.get("merge_reason", ""))[:200] or None,
        }
    facts.update({"alert_resolved_in_wait": resolved, "journey_now": numbers})
    return render(
        "follow-up",
        incident=number,
        alert=alert,
        env=env,
        action=action,
        runbook=f"{RUNBOOKS}/{alert}.md",
        untrusted_github=untrusted_github(),
        facts="```json\n" + json.dumps(facts, indent=2, sort_keys=True) + "\n```",
    )


def stalled_body(alert: str, status: str, env: str, title: str, run_url: str, reason: str) -> str:
    if not RUN_URL.fullmatch(run_url):
        raise Invalid("not a run of this repo")
    if alert not in d.ALERTS or env not in d.DEPLOYED or status not in d.STATUSES:
        raise Invalid("unknown alert, environment or status")
    return render(
        "stalled",
        alert=alert,
        status=status,
        env=env,
        incident_title=title,
        runbook=f"{RUNBOOKS}/{alert}.md",
        run_url=run_url,
        reason=_one_line(reason) or "no reason recorded",
    )


# --- CLI ------------------------------------------------------------------------------


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
        if command == "incident" and len(args) == 6:
            return incident(args[0], args[1], args[2], args[3], args[4], args[5])
        if command == "prompt" and len(args) >= 2:
            return prompt(args[0], args[1], _options(args[2:]))
        if command == "decision" and args:
            return decision(args[0], _options(args[1:]))
        if command == "check-fix" and len(args) == 2:
            problems = check_fix(*args)
            for p in problems:
                print(f"::error title=Fix refused::{json.dumps(p)}")
            return 1 if problems else 0
        if command == "pr-body" and len(args) == 2:
            text = sys.stdin.read() if args[0] == "-" else Path(args[0]).read_text()
            print(pr_body(text, _number(args[1], "incident")), end="")
            return 0
        if command == "patch-body" and len(args) == 2:
            print(patch_body(args[0], str(_number(args[1], "incident"))), end="")
            return 0
        if command == "review-prompt" and len(args) == 3:
            pr, number = _number(args[1], "pr"), _number(args[2], "incident")
            return _write(args[0], "review-prompt.md", review_prompt(pr, number))
        if command == "review-result" and len(args) == 1:
            return review_result(args[0])
        if command == "merge-check" and len(args) == 2:
            reason = merge_check(
                json.loads(Path(args[0]).read_text()), _number(args[1], "incident")
            )
            _write_outputs({"ok": str(not reason).lower(), "reason": _one_line(reason)})
            return 0
        if command == "check-comment" and len(args) == 1:
            try:
                check_comment(Path(args[0]))
            except Invalid as e:
                print(f"::warning title=No report::{json.dumps(str(e))}")
                return 1
            return 0
        if command == "check-pr" and len(args) == 2:
            pr_data = json.loads(Path(args[0]).read_text())
            problems = check_pr(pr_data, _number(args[1], "incident"))
            for p in problems:
                print(f"::error title=Not the on-call fix PR::{json.dumps(p)}")
            return 1 if problems else 0
        if command == "not-merged-body" and len(args) == 4:
            number, pr = _number(args[0], "incident"), _number(args[1], "pr")
            print(not_merged_body(number, pr, args[2], args[3]), end="")
            return 0
        if command == "merged-body" and len(args) == 4:
            if args[0] not in d.DEPLOYED:
                raise Invalid("unknown environment")
            print(
                merged_body(args[0], _number(args[1], "incident"), _number(args[2], "pr"), args[3]),
                end="",
            )
            return 0
        if command == "follow-up-prompt" and args:
            return _write(args[0], "follow-up-prompt.md", follow_up_prompt(_options(args[1:])))
        if command == "stalled-body" and len(args) == 6:
            print(stalled_body(*args), end="")
            return 0
        if command == "open-fix-pr" and len(args) == 2:
            found = open_fix_pr(json.loads(Path(args[0]).read_text()), _number(args[1], "incident"))
            print(found or "")
            return 0
    except Invalid as e:
        print(f"::error title=on-call::{json.dumps(str(e))}")
        return 1
    print(__doc__, file=sys.stderr)
    return 2


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
