#!/usr/bin/env python3
"""The on-call workflow's deterministic logic (#35): everything around the Claude sessions.

.github/workflows/oncall.yml runs the agents with read-only tokens. Every write to GitHub
(the incident issue, labels, the fix branch and PR, the review, the merge, the rollback)
is a workflow step that runs this script on a fresh checkout, never inside a session. What
crosses from a session to those steps is a file the step checks: decision.json, a comment,
a review verdict, a git bundle. State passes from one session to the next only through the
checked values in its prompt, never through what an earlier session wrote on the issue.

    cap-runs <event.json> <runs.json> <run id>
        # the earlier runs the daily cap looks at (same alert and environment, last 24 h),
        # one ID per line, for the step that reads each one's jobs
    incident <event.json> <issues.json> <prs.json> <runs.json> <run id> <out dir> <jobs dir>
        # find (or plan) the incident issue, the daily run cap (runs whose agent session
        # started, from <jobs dir>/<run id>.json), what the incident already had;
        # GITHUB_OUTPUT: alert, environment, status, incident, create, rolled_back, open_pr,
        # capped, cap_notice, close_capped, run_agent; writes incident-body.md, cap-body.md
    capped-summary <event.json> <incident> <issues.json> <runs.json> <run id>
        <comments.json> <open pr or "">
        # a resolution over the cap (#312): the workflow's own incident summary, no session
    prompt <event.json> <out dir> --incident <n> --rolled-back <bool> --open-pr <n>
        # the on-call agent's prompt.md and alert.json
    decision <dir> --status <s> --environment <env> --incident <n> --rolled-back <bool>
        --open-pr <n> [--run-url <url>]
        # the agent's decision.json and comment.md, checked; GITHUB_OUTPUT: action,
        # rollback_tag, branch, cause, reason ("stalled" when they don't pass); writes
        # <dir>/update.md: the comment, then the workflow's record of the decision
    check-fix <branch> <incident>
        # the agent's fix branch, in this checkout: name, base, files, size
    pr-body <pr.md or -> <incident>      # the fix PR's body: `Refs #<n>`, never Closes
    patch-body <branch> <incident>       # the fallback: the fix as a diff, ⛔ Needs Yacine
    review-prompt <out dir> <pr> <incident>
    review-result <dir>                  # GITHUB_OUTPUT: verdict, body
    check-comment <file>                 # a session's comment: there, not empty, not huge
    check-pr <pr.json> <incident>        # the PR the reviewer reviews
    merge-check <pr.json> <incident>     # GITHUB_OUTPUT: ok, reason
    not-merged-body <incident> <pr> <reason> <app|fallback|none> [<session line>]
    squash-body <incident> <pr>          # the squash commit's body: the workflow's text
    merged-body <environment> <incident> <pr> <sha>
    follow-up-prompt <out dir> --key value ...
    stalled-body <alert> <status> <environment> <incident title> <run url> <reason>
        [<session line>]
    commit-check <message> <path>...     # what scripts/oncall-commit.sh refuses; exit 1
    reviewer-agent                       # the headless review's agent, as `--agents` JSON
    session-summary <result.json> respond|review|follow-up
        # after a session: Claude Code's result (subtype, turns, cost, refused tool calls,
        # named safely) in the step summary; GITHUB_OUTPUT: session (one line)
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
# Runs per alert and environment in 24 hours in which the on-call agent session started
# (firing, repeats and resolution). Runs with no session (capped, skipped, no agent job)
# don't count, and a resolution over the cap still closes its incident, with the
# workflow's own summary and no session (#312). The Anthropic spend limit is the backstop.
DAILY_RUN_CAP = 4
# How the cap tells, from a run's jobs (`gh run view <id> --json jobs`), that its agent
# session started and that it posted the cap's ⛔: the job and step names in oncall.yml
# (tested, so a rename there fails here).
SESSION_JOB = "On-call agent"
SESSION_STEP = "Run the on-call agent"
INCIDENT_JOB = "Incident issue"
CAP_STEP = "Post the daily cap"
# The account the workflow token posts as.
WORKFLOW_BOT = "github-actions[bot]"
# The workflow's record of a checked decision: the last line of the comment it posts for
# it (#312). Session text can't carry one: check_comment refuses it.
DECISION_MARKER = re.compile(r"<!-- oncall:decision (\{.*\}) -->")
MARKER_TEXT = re.compile(r"<!--\s*oncall\s*:", re.IGNORECASE)
# The decision's cause as the workflow's summary may show it: one line, at most MAX_CAUSE
# characters of letters, digits, spaces and `_ . , ; : ( ) ' / % + = -` (no mention,
# link, issue reference, HTML or Markdown).
CAUSE_UNSAFE = re.compile(r"[^A-Za-z0-9 _.,;:()'/%+=-]")
MAX_CAUSE = 200
# Runs this long before the incident opened still belong to it: the run that opens an
# issue starts before the issue exists.
RUN_MARGIN = dt.timedelta(minutes=10)
MAX_LISTED_RUNS = 20
RUN_ID = re.compile(r"[1-9][0-9]{0,19}")
MAX_COMMENT = 20_000
MAX_FIX_FILES = 20
MAX_FIX_LINES = 1000
# A fix may not touch what guards the agents: the workflows (the App can't push them
# anyway), the Claude Code settings and agent definitions, this workflow's own logic and
# every module it imports, and the App token scripts the write steps run.
PROTECTED_PATHS = (
    "^\\.github/",
    "^\\.claude/",
    "^infra/github/",
    "^scripts/oncall",
    # oncall.py's imports, transitively (grafana_*.py import check_local_stack lazily)
    "^scripts/alert_dispatch\\.py$",
    "^scripts/alert_routing\\.py$",
    "^scripts/check_local_stack\\.py$",
    "^scripts/grafana_alerts\\.py$",
    "^scripts/grafana_dashboards\\.py$",
    "^scripts/reviewer_token\\.py",
    "^scripts/reviewer-review\\.sh$",
    # The respond session's only way to commit (#232); `^scripts/oncall` covers it, named
    # here so the sync test and the wrapper's denies keep it.
    "^scripts/oncall-commit\\.sh$",
    # The tests that pin those guards (#232): a fix mustn't loosen them with its change.
    "^scripts/tests/test_oncall",
    "^scripts/tests/oncall_sim\\.py$",
    "^scripts/tests/test_claude_settings\\.py$",
)
# Token-shaped text a fix branch must never carry, in a commit message or an added line
# (#232): the Claude key, a Grafana token, a GitHub token, a PEM key.
SECRET_SHAPES = re.compile(r"sk-ant-|glsa_|gh[opsu]_[A-Za-z0-9]|github_pat_|-----BEGIN")
VERDICTS = ("approve", "request-changes")
RUN_URL = re.compile(rf"https://github\.com/{re.escape(d.REPOSITORY)}/actions/runs/[0-9]+")
RUN_RESULTS = ("success", "failure", "skipped-recent", "not-run")
# GitHub's closing keywords before any issue reference it links: `#5`, `owner/repo#5` or
# an issue URL. Matched up to the reference, which stays.
CLOSING = re.compile(
    r"\b(close[sd]?|fix(?:e[sd])?|resolve[sd]?)\b(?:\s*:)?\s+"
    r"(?=(?:[\w.-]+/[\w.-]+)?#[0-9]"
    r"|https?://(?:www\.)?github\.com/[\w.-]+/[\w.-]+/issues/[0-9])",
    re.IGNORECASE,
)


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


def _alert_runs(runs: list[dict[str, Any]], payload: dict[str, Any]) -> list[dict[str, Any]]:
    """This workflow's runs for the same alert and environment, by their run name."""
    pattern = re.compile(
        rf"Alert: {re.escape(payload['alert'])} (firing|resolved) in "
        rf"{re.escape(payload['environment'])}"
    )
    return [
        r
        for r in runs
        if pattern.fullmatch(str(r.get("displayTitle", "")))
        and RUN_ID.fullmatch(str(r.get("databaseId", "")))
        and r.get("createdAt")
    ]


def cap_runs(
    runs: list[dict[str, Any]], payload: dict[str, Any], run_id: str, now: dt.datetime
) -> list[str]:
    """The earlier runs the cap looks at, newest first: same alert and environment, last
    24 h. Their jobs say whether each one's session started."""
    since = now - dt.timedelta(hours=24)
    found = [
        r
        for r in _alert_runs(runs, payload)
        if str(r["databaseId"]) != run_id and _time(str(r["createdAt"])) >= since
    ]
    found.sort(key=lambda r: _time(str(r["createdAt"])), reverse=True)
    return [str(r["databaseId"]) for r in found]


def _step(jobs: Any, job_name: str, step_name: str) -> dict[str, Any] | None:
    if not isinstance(jobs, dict) or not isinstance(jobs.get("jobs"), list):
        return None
    for job in jobs["jobs"]:
        if isinstance(job, dict) and job.get("name") == job_name:
            for step in job.get("steps") or []:
                if isinstance(step, dict) and step.get("name") == step_name:
                    return step
    return None


def _step_ran(step: dict[str, Any] | None) -> bool:
    """Running, or finished with anything but `skipped` (a failure or a cancel counts)."""
    if step is None:
        return False
    if step.get("status") == "in_progress":
        return True
    return step.get("status") == "completed" and step.get("conclusion") not in (
        "skipped",
        "",
        None,
    )


def session_started(jobs: Any) -> bool:
    """Whether a run's on-call agent session started, from `gh run view --json jobs`. A
    run whose jobs couldn't be read (None) counts: the cap bounds cost, so an unknown run
    is counted rather than ignored."""
    return jobs is None or _step_ran(_step(jobs, SESSION_JOB, SESSION_STEP))


def cap_posted(jobs: Any) -> bool:
    """Whether a run posted the cap's ⛔ (its incident job ran the step)."""
    return _step_ran(_step(jobs, INCIDENT_JOB, CAP_STEP))


def _run_jobs(jobs_dir: Path, run: str) -> Any:
    try:
        return json.loads((jobs_dir / f"{run}.json").read_text())
    except (OSError, json.JSONDecodeError):
        return None


def incident(
    event_path: str,
    issues_path: str,
    prs_path: str,
    runs_path: str,
    run_id: str,
    out: str,
    jobs_dir: str,
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
    earlier = [_run_jobs(Path(jobs_dir), r) for r in cap_runs(runs, payload, run_id, now)]
    count = sum(1 for jobs in earlier if session_started(jobs))
    capped = count >= DAILY_RUN_CAP
    # A resolution needs no paid session: over the cap, the workflow closes the incident
    # with its own summary (#312).
    close_capped = capped and payload["status"] == "resolved" and number is not None
    # The cap's ⛔ once in 24 hours: not when an earlier run in the window posted it, and
    # not for a resolution, which the workflow still handles.
    cap_notice = (
        capped and payload["status"] == "firing" and not any(cap_posted(j) for j in earlier)
    )
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
            "cap_notice": str(cap_notice).lower(),
            "close_capped": str(close_capped).lower(),
            "run_agent": str(run_agent).lower(),
        }
    )
    what = f"#{number}" if number else ("a new one" if create else "none (nothing to do)")
    print(
        f"ok    {payload['alert']} {payload['status']} in {payload['environment']}; incident "
        f"{what}; {count} of {len(earlier)} earlier runs in 24 h had an agent session "
        f"(cap {DAILY_RUN_CAP})"
    )
    return 0


# --- A resolution over the cap (#312) -------------------------------------------------


def _cause(value: Any) -> str:
    return _one_line(CAUSE_UNSAFE.sub("", _one_line(str(value))))[:MAX_CAUSE].strip()


def decision_marker(action: str, cause: str, run_url: str) -> str:
    """The workflow's record of a checked decision, on the last line of the act job's
    comment: what a capped resolution's summary reads back."""
    record = {"action": action, "cause": _cause(cause), "run": run_url}
    return f"<!-- oncall:decision {json.dumps(record, sort_keys=True)} -->"


def read_comments(text: str) -> list[dict[str, Any]]:
    """`gh api …/comments --jq '.[] | {login: …, body: …}'`: JSON objects one after the
    other, compact or not, or one array."""
    decoder = json.JSONDecoder()
    found: list[dict[str, Any]] = []
    i = 0
    while True:
        while i < len(text) and text[i].isspace():
            i += 1
        if i >= len(text):
            return found
        value, i = decoder.raw_decode(text, i)
        values = value if isinstance(value, list) else [value]
        found += [v for v in values if isinstance(v, dict)]


def last_decision(comments: list[dict[str, Any]]) -> dict[str, str] | None:
    """The last decision the workflow recorded on the incident: the marker on the last line
    of a comment by the workflow's bot, checked again here."""
    last = None
    for comment in comments:
        if comment.get("login") != WORKFLOW_BOT:
            continue
        lines = [line for line in str(comment.get("body") or "").splitlines() if line.strip()]
        m = DECISION_MARKER.fullmatch(lines[-1].strip()) if lines else None
        if not m:
            continue
        try:
            record = json.loads(m.group(1))
        except json.JSONDecodeError:
            continue
        if not isinstance(record, dict) or record.get("action") not in ACTIONS:
            continue
        run = str(record.get("run") or "")
        last = {
            "action": str(record["action"]),
            "cause": _cause(record.get("cause") or ""),
            "run": run if RUN_URL.fullmatch(run) else "",
        }
    return last


def incident_runs(
    issues: list[dict[str, Any]],
    runs: list[dict[str, Any]],
    payload: dict[str, Any],
    number: int,
    run_id: str,
) -> list[tuple[str, str, str]]:
    """The incident's on-call runs, oldest first, as (run ID, firing|resolved, created
    at): its alert and environment's runs from shortly before the incident opened (or
    this firing started, if earlier), after the previous incident of that title closed.
    This run is last, as "now"."""
    title = incident_title(payload)
    this = next((i for i in issues if str(i.get("number")) == str(number)), {})
    opened = _time(payload["started_at"])
    if this.get("createdAt"):
        opened = min(opened, _time(str(this["createdAt"])))
    since = opened - RUN_MARGIN
    for other in issues:
        closed = other.get("closedAt")
        if (
            other.get("title") == title
            and NUMBER.fullmatch(str(other.get("number", "")))
            and int(other["number"]) < number
            and closed
            and since < _time(str(closed)) <= opened
        ):
            since = _time(str(closed))
    found = [
        (str(r["databaseId"]), str(r["displayTitle"]).split()[2], str(r["createdAt"]))
        for r in _alert_runs(runs, payload)
        if str(r["databaseId"]) != run_id and _time(str(r["createdAt"])) >= since
    ]
    found.sort(key=lambda r: _time(r[2]))
    return [*found, (run_id, payload["status"], "now")]


def capped_summary(
    payload: dict[str, Any],
    number: int,
    issues: list[dict[str, Any]],
    runs: list[dict[str, Any]],
    run_id: str,
    comments: list[dict[str, Any]],
    open_pr: int | None,
) -> str:
    """The incident summary the workflow posts for a resolution over the cap. No session
    wrote it: it holds the payload's checked values, run links and the decision the
    workflow recorded, checked again."""
    if payload["status"] != "resolved":
        raise Invalid("a capped summary is for a resolved alert")
    if not RUN_ID.fullmatch(run_id):
        raise Invalid("not a run ID")
    base = f"https://github.com/{d.REPOSITORY}/actions/runs/"
    listed = incident_runs(issues, runs, payload, number, run_id)
    shown = listed[-MAX_LISTED_RUNS:]
    lines = [
        f"  - [{rid}]({base}{rid}): {status}, " + ("this run" if at == "now" else at)
        for rid, status, at in shown
    ]
    if len(listed) > len(shown):
        lines.insert(0, f"  - and {len(listed) - len(shown)} earlier ones")
    found = last_decision(comments)
    if found is None:
        action = cause = "not analysed by the agent: daily cap reached"
    else:
        where = f" (run {found['run']})" if found["run"] else ""
        action = f"`{found['action']}`{where}"
        cause = found["cause"] or "not recorded in the decision (see the agent's update above)"
    if open_pr:
        closing = (
            f"The incident stays open: its fix PR #{open_pr} is still open. Close it once that "
            "PR is merged or closed."
        )
    else:
        closing = "The workflow closes the incident."
    return render(
        "capped-summary",
        alert=payload["alert"],
        env=payload["environment"],
        title=payload["title"],
        started_at=payload["started_at"],
        resolved_at=payload["resolved_at"],
        cap=DAILY_RUN_CAP,
        action=action,
        cause=cause,
        runs="\n".join(lines),
        closing=closing,
        runbook=f"{RUNBOOKS}/{payload['alert']}.md",
    )


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
    extra = set(raw) - {"action", "rollback", "branch", "cause"}
    if extra:
        raise Invalid(f"unexpected keys: {', '.join(sorted(extra))}")
    action = raw.get("action")
    if action not in ACTIONS:
        raise Invalid(f"action {str(action)[:20]!r} is not one of {', '.join(ACTIONS)}")
    cause = raw.get("cause", "")
    if not isinstance(cause, str):
        raise Invalid("cause must be a string")
    # The cause is what the workflow's own summary shows if a resolution comes over the
    # cap (#312): cut to one safe line here.
    result: dict[str, Any] = {
        "action": action,
        "rollback_tag": "",
        "branch": "",
        "cause": _cause(cause),
    }
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
    if MARKER_TEXT.search(text):
        raise Invalid("comment.md holds the workflow's own record (<!-- oncall:…)")


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
    run_url = values.get("run_url", "")
    if run_url and not RUN_URL.fullmatch(run_url):
        raise Invalid("--run-url is not a run of this repo")
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
            {
                "action": "stalled",
                "rollback_tag": "",
                "branch": "",
                "cause": "",
                "reason": _one_line(str(e)),
            }
        )
        return 0
    # What the act job posts: the agent's comment, then the workflow's record of the
    # checked decision, which a capped resolution's summary reads back (#312).
    comment = (base / "comment.md").read_text().rstrip()
    marker = decision_marker(result["action"], result["cause"], run_url)
    (base / "update.md").write_text(f"{comment}\n\n{marker}\n")
    _write_outputs({**result, "reason": ""})
    print(f"ok    decision: {result['action']} for incident #{context['incident']}")
    return 0


def _one_line(text: str) -> str:
    return " ".join(text.split())[:300]


# --- The fix branch -------------------------------------------------------------------

MAX_COMMIT_MESSAGE = 500


def commit_problems(root: Path, message: str, paths: list[str]) -> list[str]:
    """What scripts/oncall-commit.sh refuses (#232): the respond session's only way to
    stage and commit. Its arguments come from a session that reads untrusted text, so
    nothing in them may become a git option, reach outside the checkout or a guarded file,
    or put a key or a closing keyword in the commit."""
    problems = []
    if not message.strip() or message.startswith("-") or len(message) > MAX_COMMIT_MESSAGE:
        problems.append(f"the message must be 1 to {MAX_COMMIT_MESSAGE} characters, not '-…'")
    if any((c < " " and c != "\n") or c == "\x7f" for c in message):
        problems.append("the message holds a control character")
    if CLOSING.search(message):
        problems.append("the message has a closing keyword (Closes/Fixes/Resolves #n): use Refs")
    if SECRET_SHAPES.search(message):
        problems.append("the message holds token-shaped text (a key or a token)")
    if not paths:
        problems.append("name at least one file to commit")
    real_root = root.resolve()
    for given in paths:
        shown = json.dumps(given[:80])
        if not given or given.startswith("-") or any(c < " " or c == "\x7f" for c in given):
            problems.append(f"{shown} isn't a plain path")
            continue
        path = Path(os.path.normpath(real_root / given))
        resolved = path.resolve()
        if any(real_root not in p.parents for p in (path, resolved)):
            problems.append(f"{shown} is outside the checkout")
            continue
        names = {path.relative_to(real_root).as_posix(), resolved.relative_to(real_root).as_posix()}
        if any(n == ".git" or n.startswith(".git/") for n in names):
            problems.append(f"{shown} is in .git")
        elif any(re.search(p, n) for p in PROTECTED_PATHS for n in names):
            problems.append(f"{shown} is a file the fix may not change")
        elif path.is_dir() or resolved.is_dir():
            problems.append(f"{shown} is a directory: name the files")
    return problems


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
    # --no-renames: a rename then lists its old path too, so moving a protected file out
    # of its place is refused like deleting or editing it. -z: paths come raw, not quoted
    # (git quotes a non-ASCII path, which would slip past the patterns).
    diff = ("diff", "--no-renames", "-z")
    files = [f for f in _git(*diff, "--name-only", f"origin/main...{branch}").split("\0") if f]
    for f in files:
        if any(re.search(p, f) for p in PROTECTED_PATHS):
            problems.append(f"the fix may not change {f}")
    if len(files) > MAX_FIX_FILES:
        problems.append(f"the fix changes {len(files)} files (at most {MAX_FIX_FILES})")
    lines = 0
    for row in _git(*diff, "--numstat", f"origin/main...{branch}").split("\0"):
        if row.count("\t") < 2:
            continue
        added, removed, _ = row.split("\t", 2)
        lines += int(added) + int(removed) if added.isdigit() and removed.isdigit() else 0
    if lines > MAX_FIX_LINES:
        problems.append(f"the fix changes {lines} lines (at most {MAX_FIX_LINES})")
    messages = _git("log", "--format=%B", f"origin/main..{branch}")
    if CLOSING.search(messages):
        problems.append(
            "a commit message has a closing keyword (Closes/Fixes/Resolves and an issue): use Refs"
        )
    if SECRET_SHAPES.search(messages):
        problems.append("a commit message holds token-shaped text (a key or a token)")
    new_lines = [
        line
        for line in _git("diff", "--no-renames", "-U0", f"origin/main...{branch}").splitlines()
        if line.startswith("+") and not line.startswith("+++")
    ]
    if any(SECRET_SHAPES.search(line) for line in new_lines):
        problems.append("the fix adds token-shaped text (a key or a token)")
    if not any(re.search(r"(^|/)tests?/|(^|/)test_[^/]*\.py$|\.test\.tsx?$", f) for f in files):
        problems.append("the fix has no test file (a regression test comes with it)")
    return problems


def pr_body(text: str, number: int) -> str:
    """The fix PR's body: the agent's text with closing keywords disarmed, and `Refs`.
    The incident closes when the alert resolves, not when the fix reaches dev."""
    disarmed = CLOSING.sub(lambda m: f"{m.group(1)} (ref) ", text.strip())
    return f"{disarmed}\n\nRefs #{number}\n\nOpened by the on-call workflow (#35).\n"


def patch_body(branch: str, number: str) -> str:
    diff = _git("diff", f"origin/main...{branch}")
    if len(diff) > MAX_COMMENT - 2000:
        diff = diff[: MAX_COMMENT - 2000] + "\n… (cut; the whole patch is in the run's artifact)\n"
    return render("patch", incident=number, branch=branch, diff=diff.replace("```", "`​``"))


# --- Review and merge -----------------------------------------------------------------


REVIEWER = REPO / ".claude" / "agents" / "reviewer.md"
CI_REVIEWER = "oncall-reviewer"


def ci_reviewer_agent(path: Path = REVIEWER) -> dict[str, Any]:
    """The headless review's agent (#232), for `claude --agents`: the reviewer's own
    definition (description, model, instructions) plus Write, so it can leave review.md
    and review.json. The reviewer people run stays read-only (no Write or Edit in its
    file); this one's Write is scoped to those two files by scripts/oncall-claude.sh."""
    text = path.read_text()
    if not text.startswith("---\n") or "\n---\n" not in text[4:]:
        raise Invalid(f"{path.name} has no front matter")
    front, body = text[4:].split("\n---\n", 1)
    meta = dict(line.split(": ", 1) for line in front.splitlines() if ": " in line)
    tools = [t.strip() for t in meta.get("tools", "").split(",") if t.strip()]
    if not body.strip() or not meta.get("description") or not tools:
        raise Invalid(f"{path.name} lacks a description, tools or instructions")
    agent: dict[str, Any] = {
        "description": meta["description"],
        "prompt": body.strip(),
        "tools": [*tools, "Write"] if "Write" not in tools else tools,
    }
    if meta.get("model"):
        agent["model"] = meta["model"]
    return {CI_REVIEWER: agent}


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


def not_merged_body(number: int, pr: int, reason: str, posted: str, session: str = "") -> str:
    why = NOT_MERGED_WHY.get(
        posted, "No review was posted: the reviewer session didn't finish, or posting it failed."
    )
    return render(
        "not-merged",
        incident=number,
        pr=pr,
        reason=_one_line(reason),
        why=why,
        session=_session_note(session),
    )


def squash_body(number: int, pr: int) -> str:
    """The squash commit's body: the workflow's own text, never the branch's."""
    return (
        f"On-call fix for incident #{number}, from PR #{pr}, merged by the on-call workflow "
        "(#35) after the reviewer App's approval and green CI.\n\n"
        f"Refs #{number}\n"
    )


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


def stalled_body(
    alert: str, status: str, env: str, title: str, run_url: str, reason: str, session: str = ""
) -> str:
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
        session=_session_note(session),
    )


# --- What a session's Claude Code run ended with (#232) -------------------------------

SESSIONS = ("respond", "review", "follow-up")
# What of a refused tool call may reach a comment (#232): the tool's name, and for Bash
# the command's first word and at most one subcommand-like word, each a lowercase word
# (no `/`, `:`, `_`, `@`, `#`, digits first or dots). A file tool's file only when it's one
# of the sessions' own output files. Everything else in the input stays out: a command,
# a URL or a path can carry text the session read from Grafana or GitHub, a token, or a
# user's goal.
TOOL_NAME = re.compile(r"[A-Z][A-Za-z]{0,30}")
COMMAND_WORD = re.compile(r"[a-z][a-z0-9-]{0,30}")
OUTPUT_FILES = ("decision.json", "comment.md", "pr.md", "review.md", "review.json", "prompt.md")
# The line as posted, checked again where it's posted: letters, digits, spaces and
# `_ . , ; ( ) $ ' -` only.
SAFE_LINE = re.compile(r"[^A-Za-z0-9 _.,;()$'-]")
MAX_LABELS = 5


def _denied_label(denial: Any) -> str:
    """A refused tool call, named safely (see TOOL_NAME, COMMAND_WORD, OUTPUT_FILES)."""
    if not isinstance(denial, dict):
        return "?"
    tool = str(denial.get("tool_name", ""))
    if not TOOL_NAME.fullmatch(tool):
        return "?"
    given = denial.get("tool_input")
    given = given if isinstance(given, dict) else {}
    if tool == "Bash":
        words = []
        for word in str(given.get("command", "")).split()[:2]:
            if not COMMAND_WORD.fullmatch(word):
                break
            words.append(word)
        return f"Bash({' '.join(words)})" if words else "Bash"
    name = Path(str(given.get("file_path", ""))).name
    return f"{tool}({name})" if name in OUTPUT_FILES else tool


def session_result(raw: Any) -> tuple[str, list[str]]:
    """Claude Code's `--output-format json` result, as one safe line and the refused calls:
    the result's subtype, turns, cost, and each refused tool call's label with its count."""
    if not isinstance(raw, dict) or raw.get("type", "result") != "result":
        return "Claude Code left no result (the step's time cap, or the CLI failed)", []
    subtype = str(raw.get("subtype", ""))
    subtype = subtype if re.fullmatch(r"[a-z_]{1,40}", subtype) else "unknown"
    parts = [f"ended with {subtype}" + (" (an error)" if raw.get("is_error") is True else "")]
    turns, cost = raw.get("num_turns"), raw.get("total_cost_usd")
    if isinstance(turns, int) and not isinstance(turns, bool):
        parts.append(f"after {turns} turns")
    if isinstance(cost, (int, float)) and not isinstance(cost, bool):
        parts.append(f"for ${cost:.2f}")
    denials = raw.get("permission_denials")
    denials = denials if isinstance(denials, list) else []
    counts: dict[str, int] = {}
    for denial in denials:
        label = _denied_label(denial)
        counts[label] = counts.get(label, 0) + 1
    labels = [f"{label} x{n}" for label, n in sorted(counts.items(), key=lambda kv: -kv[1])]
    line = ", ".join(parts)
    if denials:
        shown = ", ".join(labels[:MAX_LABELS])
        more = f" and {len(labels) - MAX_LABELS} more" if len(labels) > MAX_LABELS else ""
        line += f"; {len(denials)} tool calls refused, {shown}{more}"
    else:
        line += "; no tool call refused"
    return line, labels


def session_summary(result_path: str, session: str) -> int:
    """After a session: its result in the step summary and the job's `session` output, for
    the ⛔ Needs Yacine: comment when the session leaves nothing usable."""
    if session not in SESSIONS:
        raise Invalid(f"unknown session {session!r}")
    try:
        raw: Any = json.loads(Path(result_path).read_text())
    except (OSError, json.JSONDecodeError):
        raw = None
    line, labels = session_result(raw)
    summary = os.environ.get("GITHUB_STEP_SUMMARY")
    if summary:
        rows = "".join(f"- `{label}`\n" for label in labels)
        intro = "Refused tool calls (the session's allow list is in scripts/oncall-claude.sh):"
        refused = f"\n{intro}\n\n{rows}" if rows else ""
        with open(summary, "a") as f:
            f.write(f"### Claude Code session: {session}\n\n{line}\n{refused}\n")
    level = "warning" if labels or "error" in line or "no result" in line else "notice"
    print(f"::{level} title=Claude Code session ({session})::{json.dumps(line)}")
    _write_outputs({"session": line})
    return 0


def _session_note(session: str) -> str:
    """The session's line in a comment: checked again here, on the fresh checkout, since
    the job that wrote it ran a session."""
    text = _one_line(SAFE_LINE.sub("", _one_line(session)))
    return f"\n\nClaude Code: {text}." if text else ""


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
        if command == "cap-runs" and len(args) == 3:
            payload = _checked_payload(args[0])
            runs = json.loads(Path(args[1]).read_text() or "[]")
            for run in cap_runs(runs, payload, args[2], dt.datetime.now(dt.UTC)):
                print(run)
            return 0
        if command == "incident" and len(args) == 7:
            return incident(args[0], args[1], args[2], args[3], args[4], args[5], args[6])
        if command == "capped-summary" and len(args) == 7:
            body = capped_summary(
                _checked_payload(args[0]),
                _number(args[1], "incident"),
                json.loads(Path(args[2]).read_text() or "[]"),
                json.loads(Path(args[3]).read_text() or "[]"),
                args[4],
                read_comments(Path(args[5]).read_text()),
                _optional_number(args[6], "open_pr"),
            )
            print(body, end="")
            return 0
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
        if command == "not-merged-body" and len(args) in (4, 5):
            number, pr = _number(args[0], "incident"), _number(args[1], "pr")
            print(not_merged_body(number, pr, *args[2:]), end="")
            return 0
        if command == "squash-body" and len(args) == 2:
            print(squash_body(_number(args[0], "incident"), _number(args[1], "pr")), end="")
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
        if command == "stalled-body" and len(args) in (6, 7):
            print(stalled_body(*args), end="")
            return 0
        if command == "session-summary" and len(args) == 2:
            return session_summary(args[0], args[1])
        if command == "commit-check" and args:
            problems = commit_problems(Path.cwd(), args[0], args[1:])
            for p in problems:
                print(f"refused: {p}", file=sys.stderr)
            return 1 if problems else 0
        if command == "reviewer-agent" and not args:
            print(json.dumps(ci_reviewer_agent()))
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
