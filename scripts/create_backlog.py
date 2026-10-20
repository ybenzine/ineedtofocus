"""Create labels, milestones and issues from backlog.yaml via the GitHub REST API (gh api).
Idempotent: skips labels/milestones/issues that already exist (matched by name/title).
Usage: python3 scripts/create_backlog.py OWNER/REPO [--dry-run]
"""
import json, subprocess, sys, yaml

repo = sys.argv[1]
dry = "--dry-run" in sys.argv
data = yaml.safe_load(open(__import__("pathlib").Path(__file__).resolve().parent.parent / "_docs/backlog/backlog.yaml"))

DOD = """## Definition of done
- [ ] Every acceptance criterion above is met and checked off
- [ ] Tests added or updated; `make test` passes locally and in CI
- [ ] PR references this issue (`Closes #<n>`) and the reviewer agent's verdict is Approve
- [ ] Product manager accepted it (`accepted` label)
- [ ] Docs updated if behavior or setup changed"""


def gh(method, path, payload=None, paginate=False):
    cmd = ["gh", "api", "-X", method, f"repos/{repo}/{path}"]
    if paginate:
        cmd.insert(2, "--paginate")
    if payload is not None:
        cmd += ["--input", "-"]
    if dry and method != "GET":
        print("DRY", method, path, (payload or {}).get("title") or (payload or {}).get("name"))
        return {"number": 0}
    out = subprocess.run(cmd, input=json.dumps(payload) if payload is not None else None,
                         capture_output=True, text=True)
    if out.returncode != 0:
        raise SystemExit(f"{method} {path} failed: {out.stderr or out.stdout}")
    return json.loads(out.stdout) if out.stdout.strip() else {}


def body(issue):
    owners = [l.split(":", 1)[1] for l in issue["labels"] if l.startswith(("agent:", "owner:"))]
    parts = []
    if owners:
        parts.append(f"**Owner:** {', '.join(owners)}")
    if issue.get("context"):
        parts.append("## Context\n" + issue["context"].strip())
    parts.append("## Acceptance criteria\n" + "\n".join(f"- [ ] {a}" for a in issue["ac"]))
    if "post-mvp" not in issue["labels"]:
        parts.append(DOD)
    if issue.get("refs"):
        parts.append("## References\n" + "\n".join(f"- {r}" for r in issue["refs"]))
    return "\n\n".join(parts) + "\n"


existing_labels = {l["name"] for l in gh("GET", "labels?per_page=100", paginate=True)}
for l in data["labels"]:
    if l["name"] not in existing_labels:
        gh("POST", "labels", l)
        print("label +", l["name"])

existing_ms = {m["title"]: m["number"] for m in gh("GET", "milestones?state=all&per_page=100", paginate=True)}
ms_num = {}
for m in data["milestones"]:
    if m["title"] in existing_ms:
        ms_num[m["key"]] = existing_ms[m["title"]]
        continue
    payload = {k: v for k, v in m.items() if k in ("title", "description", "due_on")}
    ms_num[m["key"]] = gh("POST", "milestones", payload)["number"]
    print("milestone +", m["title"])

existing_issues = {i["title"] for i in gh("GET", "issues?state=all&per_page=100", paginate=True)}
for issue in data["issues"]:
    if issue["title"] in existing_issues:
        continue
    created = gh("POST", "issues", {
        "title": issue["title"],
        "body": body(issue),
        "labels": issue["labels"],
        "milestone": ms_num[issue["milestone"]],
    })
    print(f"issue #{created['number']} +", issue["title"])
