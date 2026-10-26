"""The deploy rules in .github/workflows/ (#27, #28, #29) that a workflow edit must not
break silently: the five required check names, publish's gate, deploy-dev's gate,
environment, concurrency and use of the forced command, and deploy-prod.yml's manual-only
trigger, `production` environment, secrets and requests (its own tests below)."""

from __future__ import annotations

import json
import re
import shutil
import subprocess
from pathlib import Path
from typing import Any

import pytest
import yaml  # type: ignore[import-untyped]  # no stubs in the locked env

REPO = Path(__file__).resolve().parents[2]
WORKFLOWS = REPO / ".github" / "workflows"
CI = WORKFLOWS / "ci.yml"
DEPLOY_PROD = WORKFLOWS / "deploy-prod.yml"
PROTECTION = REPO / "infra" / "github" / "main-branch-protection.json"
FOCUS_CI = REPO / "infra" / "server" / "focus-ci.sh"
REQUIRED_JOBS = ["lint", "backend-unit", "backend-integration", "frontend-unit", "e2e"]
MAIN_PUSH_ONLY = "github.event_name == 'push' && github.ref == 'refs/heads/main'"


def load_workflow(path: Path) -> dict[Any, Any]:
    """A workflow, with each step's effective shell in `_shell` (the step's own `shell`,
    else the job's, else the workflow's `defaults.run.shell`, else None), so the steps run
    here exactly as GitHub runs them."""
    data: dict[Any, Any] = yaml.safe_load(path.read_text())
    top = (data.get("defaults") or {}).get("run", {}).get("shell")
    for job in data["jobs"].values():
        job_shell = (job.get("defaults") or {}).get("run", {}).get("shell", top)
        for step in job.get("steps", []):
            step["_shell"] = step.get("shell", job_shell)
    return data


def run_like_github(
    step: dict[str, Any], tmp_path: Path, env: dict[str, str], cwd: Path | None = None
) -> subprocess.CompletedProcess[str]:
    """Run a step's `run` the way GitHub's runner does on Linux: the script in a file, run
    with `bash -e {0}` when no shell is set, or `bash --noprofile --norc -eo pipefail {0}`
    for `shell: bash`. Adding pipefail here for every step would hide a missing one. `cwd`
    stands for the job's checkout."""
    script = tmp_path / "step.sh"
    script.write_text(step["run"])
    shell = step.get("_shell", step.get("shell"))
    if shell is None:
        argv = ["bash", "-e", str(script)]
    elif shell == "bash":
        argv = ["bash", "--noprofile", "--norc", "-eo", "pipefail", str(script)]
    else:
        raise AssertionError(f"unexpected shell {shell!r}")
    return subprocess.run(argv, env=env, capture_output=True, text=True, check=False, cwd=cwd)


@pytest.fixture(scope="module")
def workflow() -> dict[Any, Any]:
    data: dict[Any, Any] = load_workflow(CI)
    return data


@pytest.fixture(scope="module")
def jobs(workflow: dict[Any, Any]) -> dict[str, Any]:
    result: dict[str, Any] = workflow["jobs"]
    return result


def steps_text(job: dict[str, Any]) -> str:
    return "\n".join(str(step.get("run", "")) for step in job["steps"])


def test_required_check_names_match_branch_protection(jobs: dict[str, Any]) -> None:
    contexts = [
        c["context"] for c in json.loads(PROTECTION.read_text())["required_status_checks"]["checks"]
    ]
    assert [jobs[job]["name"] for job in REQUIRED_JOBS] == contexts


def test_only_publish_writes_packages(jobs: dict[str, Any]) -> None:
    writers = [
        name for name, job in jobs.items() if job.get("permissions", {}).get("packages") == "write"
    ]
    assert writers == ["publish"]


def test_publish_runs_on_main_after_every_check_and_outputs_the_digest(
    jobs: dict[str, Any],
) -> None:
    publish = jobs["publish"]
    assert publish["if"] == MAIN_PUSH_ONLY
    assert sorted(publish["needs"]) == sorted([*REQUIRED_JOBS, "image"])
    assert publish["outputs"]["digest"] == "${{ steps.push.outputs.digest }}"
    assert 'echo "digest=${digest#*@}" >> "$GITHUB_OUTPUT"' in steps_text(publish)


def test_deploy_dev_runs_only_after_publish_on_main(jobs: dict[str, Any]) -> None:
    deploy = jobs["deploy-dev"]
    assert deploy["needs"] == "publish"
    assert deploy["if"] == MAIN_PUSH_ONLY
    assert deploy["env"]["TAG"] == "${{ github.sha }}"
    assert deploy["env"]["DIGEST"] == "${{ needs.publish.outputs.digest }}"


def test_deploy_dev_uses_the_dev_environment_and_its_own_group(jobs: dict[str, Any]) -> None:
    """No GitHub deployment from deploy-dev itself (#257): dev-deployment creates it."""
    deploy = jobs["deploy-dev"]
    assert deploy["environment"] == {"name": "dev", "deployment": False}
    assert deploy["concurrency"] == {"group": "deploy-dev", "cancel-in-progress": False}
    assert deploy["permissions"] == {"contents": "read", "attestations": "read"}


def test_secrets_appear_only_where_they_belong(jobs: dict[str, Any]) -> None:
    """The deploy key is read only in deploy-dev; no other job reads a non-GITHUB_TOKEN secret."""
    for name, job in jobs.items():
        found = set(re.findall(r"secrets\.([A-Z_]+)", yaml.safe_dump(job)))
        allowed = {"GITHUB_TOKEN"}
        if name == "deploy-dev":
            allowed |= {"DEPLOY_SSH_KEY", "DEPLOY_KNOWN_HOSTS"}
        assert found <= allowed, (name, found - allowed)


def test_no_trigger_that_would_deploy_without_the_gates(workflow: dict[Any, Any]) -> None:
    # PyYAML reads the `on:` key as True.
    triggers = workflow.get("on", workflow.get(True))
    assert triggers == {"pull_request": None, "push": {"branches": ["main"]}}


def test_deploy_dev_skips_without_secrets_and_gates_every_later_step(jobs: dict[str, Any]) -> None:
    steps = jobs["deploy-dev"]["steps"]
    assert steps[0]["id"] == "config"
    assert "configured=false" in steps[0]["run"] and "::notice" in steps[0]["run"]
    for step in steps[1:]:
        condition = str(step.get("if", ""))
        gated = "steps.config.outputs.configured == 'true'" in condition
        assert gated or condition == "always()", step


def test_deploy_dev_sends_requests_focus_ci_accepts(jobs: dict[str, Any]) -> None:
    """The workflow's SSH requests are the ones the forced command's patterns accept."""
    text = steps_text(jobs["deploy-dev"])
    assert 'focus-dev "deploy $TAG $DIGEST"' in text
    assert "focus-dev status" in text
    script = FOCUS_CI.read_text()
    deploy_re = re.search(r"readonly DEPLOY_RE='(.+)'", script)
    assert deploy_re
    request = f"deploy {'a' * 40} sha256:{'b' * 64}"
    assert re.fullmatch(deploy_re.group(1).strip("^$"), request)
    assert "StrictHostKeyChecking yes" in text and "BatchMode yes" in text
    assert 'rm -rf "$RUNNER_TEMP/deploy-ssh"' in text


GATE_CASES = [
    ("KEY", "HOSTS", 0, "true", ""),
    ("", "", 0, "false", "::notice title={env} deploy skipped::"),
    ("KEY", "", 1, None, "but not DEPLOY_KNOWN_HOSTS"),
    ("", "HOSTS", 1, None, "but not DEPLOY_SSH_KEY"),
]


@pytest.mark.parametrize(("key", "known_hosts", "status", "configured", "says"), GATE_CASES)
def test_deploy_dev_gate_runs_skips_or_fails(
    jobs: dict[str, Any],
    tmp_path: Path,
    key: str,
    known_hosts: str,
    status: int,
    configured: str | None,
    says: str,
) -> None:
    """The gate step itself, run with bash: deploy with both secrets, skip green with
    neither, fail red with only one (a half-configured environment)."""
    run_gate(jobs["deploy-dev"], tmp_path, key, known_hosts, status, configured, says, "Dev")


def run_gate(
    job: dict[str, Any],
    tmp_path: Path,
    key: str,
    known_hosts: str,
    status: int,
    configured: str | None,
    says: str,
    env_title: str,
) -> None:
    step = job["steps"][0]
    output, summary = tmp_path / "output", tmp_path / "summary"
    output.touch()
    summary.touch()
    env = {
        "PATH": "/usr/bin:/bin",
        "DEPLOY_SSH_KEY": key,
        "DEPLOY_KNOWN_HOSTS": known_hosts,
        "GITHUB_OUTPUT": str(output),
        "GITHUB_STEP_SUMMARY": str(summary),
    }
    result = run_like_github(step, tmp_path, env)
    assert result.returncode == status, result
    assert says.format(env=env_title) in result.stdout
    expected = f"configured={configured}\n" if configured else ""
    assert output.read_text() == expected
    if configured == "false":
        assert f"Deploy to {env_title.lower()}: skipped" in summary.read_text()


# --- Every workflow -------------------------------------------------------------------


def all_workflows() -> list[Path]:
    return sorted(WORKFLOWS.glob("*.yml")) + sorted(WORKFLOWS.glob("*.yaml"))


def test_deploy_prod_exists_under_the_name_the_deny_rules_expect() -> None:
    """File and workflow name both start with deploy-prod, so `gh workflow run` by either
    matches the deny rule."""
    assert DEPLOY_PROD in all_workflows()
    assert yaml.safe_load(DEPLOY_PROD.read_text())["name"] == "deploy-prod"
    settings = json.loads((REPO / ".claude" / "settings.json").read_text())
    assert "Bash(gh workflow run deploy-prod*)" in settings["permissions"]["deny"]


@pytest.mark.parametrize("path", all_workflows(), ids=lambda p: p.name)
def test_credentials_are_only_read_by_jobs_in_an_environment(path: Path) -> None:
    """No repo-level credential: a job reading any secret but GITHUB_TOKEN must run in a
    GitHub environment (whose secrets those are), and nothing outside jobs reads one."""
    data: dict[Any, Any] = yaml.safe_load(path.read_text())
    outside = {k: v for k, v in data.items() if k != "jobs"}
    assert not re.findall(r"secrets\.(?!GITHUB_TOKEN)", yaml.safe_dump(outside)), path
    for name, job in data["jobs"].items():
        found = set(re.findall(r"secrets\.([A-Za-z_]+)", yaml.safe_dump(job))) - {"GITHUB_TOKEN"}
        if found:
            assert job.get("environment"), (path.name, name, found)


@pytest.mark.parametrize("path", all_workflows(), ids=lambda p: p.name)
def test_actions_are_pinned_to_a_commit(path: Path) -> None:
    """Third-party actions are pinned by full commit sha with the version as a comment,
    as in ci.yml, so a moved tag can't change what runs next to a deploy key."""
    uses = re.findall(r"^\s*(?:-\s+)?uses:\s*(.+)$", path.read_text(), re.MULTILINE)
    assert uses or path != DEPLOY_PROD
    for line in uses:
        assert re.fullmatch(r"[\w.-]+/[\w./-]+@[0-9a-f]{40} # v\d[\w.]*", line.strip()), line


# --- deploy-prod.yml (#29) ------------------------------------------------------------

SHA = "a" * 40
OTHER_SHA = "b" * 40
THIRD_SHA = "d" * 40
# Deployment 11 of SHA failed dev's smoke tests; 10, a retry of the same sha, passed.
DEV_WITH_RETRY = f"12 {OTHER_SHA}\n11 {SHA}\n10 {SHA}\n"
DIGEST = "sha256:" + "c" * 64
# Not on main (a force-pushed commit, say): the compare API calls it diverged.
OFF_MAIN_SHA = "e" * 40
# Creation times of dev deployments (and rollback runs), oldest first.
T1, T2, T3, T4 = (f"2026-10-25T04:0{n}:00Z" for n in range(1, 5))


@pytest.fixture(scope="module")
def prod_workflow() -> dict[Any, Any]:
    data: dict[Any, Any] = load_workflow(DEPLOY_PROD)
    return data


@pytest.fixture(scope="module")
def prod_jobs(prod_workflow: dict[Any, Any]) -> dict[str, Any]:
    result: dict[str, Any] = prod_workflow["jobs"]
    return result


def step_named(job: dict[str, Any], prefix: str) -> dict[str, Any]:
    matches: list[dict[str, Any]] = [
        step for step in job["steps"] if str(step.get("name", "")).startswith(prefix)
    ]
    assert len(matches) == 1, prefix
    return matches[0]


def test_deploy_prod_is_started_by_hand_only(prod_workflow: dict[Any, Any]) -> None:
    """workflow_dispatch and nothing else: no push, tag, release, schedule, workflow_run or
    repository_dispatch trigger (the reviewer App can create tags, #70)."""
    triggers: dict[str, Any] = prod_workflow.get("on", prod_workflow.get(True)) or {}
    assert list(triggers) == ["workflow_dispatch"]
    inputs = triggers["workflow_dispatch"]["inputs"]
    assert list(inputs) == ["tag"]
    assert inputs["tag"]["required"] is False
    assert inputs["tag"]["default"] == ""
    assert inputs["tag"]["type"] == "string"


def test_deploy_prod_permissions_are_minimal(
    prod_workflow: dict[Any, Any], prod_jobs: dict[str, Any]
) -> None:
    assert prod_workflow["permissions"] == {}
    assert list(prod_jobs) == ["plan", "deploy"]
    assert prod_jobs["plan"]["permissions"] == {
        "contents": "read",
        "actions": "read",
        "deployments": "read",
    }
    assert prod_jobs["deploy"]["permissions"] == {"contents": "read", "attestations": "read"}


def test_deploy_prod_runs_in_production_after_the_plan(prod_jobs: dict[str, Any]) -> None:
    deploy = prod_jobs["deploy"]
    assert deploy["needs"] == "plan"
    assert deploy["environment"] == {"name": "production", "url": "https://ineedtofoc.us"}
    assert "environment" not in prod_jobs["plan"]
    assert deploy["env"]["TAG"] == "${{ needs.plan.outputs.tag }}"
    assert deploy["env"]["FROM_DEV"] == "${{ needs.plan.outputs.from_dev }}"


def test_deploy_prod_has_its_own_group_and_never_cancels(
    prod_workflow: dict[Any, Any], prod_jobs: dict[str, Any], jobs: dict[str, Any]
) -> None:
    """Not shared with deploy-dev (or #30's rollback): GitHub cancels a pending job when
    another joins its group. The server's deploy lock orders deploys across environments."""
    assert "concurrency" not in prod_workflow
    assert prod_jobs["deploy"]["concurrency"] == {
        "group": "deploy-prod",
        "cancel-in-progress": False,
    }
    assert jobs["deploy-dev"]["concurrency"]["group"] != "deploy-prod"


def test_deploy_prod_secrets_only_in_the_deploy_job(prod_jobs: dict[str, Any]) -> None:
    found = {
        name: set(re.findall(r"secrets\.([A-Za-z_]+)", yaml.safe_dump(job)))
        for name, job in prod_jobs.items()
    }
    assert found == {"plan": set(), "deploy": {"DEPLOY_SSH_KEY", "DEPLOY_KNOWN_HOSTS"}}


@pytest.mark.parametrize(("key", "known_hosts", "status", "configured", "says"), GATE_CASES)
def test_deploy_prod_gate_runs_skips_or_fails(
    prod_jobs: dict[str, Any],
    tmp_path: Path,
    key: str,
    known_hosts: str,
    status: int,
    configured: str | None,
    says: str,
) -> None:
    run_gate(prod_jobs["deploy"], tmp_path, key, known_hosts, status, configured, says, "Prod")


def test_deploy_prod_gates_every_later_step(prod_jobs: dict[str, Any]) -> None:
    steps = prod_jobs["deploy"]["steps"]
    assert steps[0]["id"] == "config"
    for step in steps[1:]:
        condition = str(step.get("if", ""))
        gated = "steps.config.outputs.configured == 'true'" in condition
        assert gated or condition == "always()", step
    assert steps[-1]["run"] == 'rm -rf "$RUNNER_TEMP/deploy-ssh"'


def test_deploy_prod_sends_requests_the_prod_profile_accepts(prod_jobs: dict[str, Any]) -> None:
    text = steps_text(prod_jobs["deploy"])
    assert 'focus-prod "deploy $TAG $DIGEST"' in text
    assert 'focus-prod "$request"' in text and 'request="candidate $TAG"' in text
    assert "focus-prod status" in text
    assert "StrictHostKeyChecking yes" in text and "BatchMode yes" in text
    script = FOCUS_CI.read_text()
    patterns = dict(re.findall(r"readonly (DEPLOY_RE|CANDIDATE_RE)='(.+)'", script))
    assert re.fullmatch(patterns["DEPLOY_RE"].strip("^$"), f"deploy {SHA} {DIGEST}")
    assert re.fullmatch(patterns["CANDIDATE_RE"].strip("^$"), f"candidate {SHA}")
    assert re.fullmatch(patterns["CANDIDATE_RE"].strip("^$"), "candidate")
    prod = re.search(r"\n  prod\)\n(.*?);;", script, re.DOTALL)
    assert prod
    assert "allowed=(deploy status candidate)" in prod.group(1)
    assert "promote_from=dev" in prod.group(1)


def test_deploy_prod_deletes_the_key_before_running_repo_code(prod_jobs: dict[str, Any]) -> None:
    """The key is on disk only for the SSH steps: removed after the record is read back,
    before the smoke test runs scripts/ from the checkout, and again at the very end."""
    steps = prod_jobs["deploy"]["steps"]
    names = [str(step.get("name", step.get("uses"))) for step in steps]
    early = step_named(prod_jobs["deploy"], "Remove the deploy key before")
    assert early["run"] == 'rm -rf "$RUNNER_TEMP/deploy-ssh"'
    assert "always()" in early["if"]
    position = names.index(early["name"])
    assert names.index(step_named(prod_jobs["deploy"], "Read the server")["name"]) < position
    assert position < names.index(step_named(prod_jobs["deploy"], "Smoke-test")["name"])
    ssh_steps = [i for i, step in enumerate(steps) if "ssh " in str(step.get("run", ""))]
    assert max(ssh_steps) < position
    assert steps[-1]["if"] == "always()"


def test_deploy_prod_smoke_tests_prod(prod_jobs: dict[str, Any]) -> None:
    deploy = prod_jobs["deploy"]
    assert deploy["env"]["PROD_URL"] == "https://ineedtofoc.us"
    smoke = step_named(deploy, "Smoke-test")
    assert smoke["run"].startswith('python3 scripts/smoke_deploy.py "$PROD_URL"')
    names = [step.get("name", step.get("uses")) for step in deploy["steps"]]
    assert names.index(smoke["name"]) > names.index(step_named(deploy, "Deploy over SSH")["name"])


FAKE_GH = r"""#!/usr/bin/env bash
# Fake gh for the plan step: canned answers (after --jq) per API path. A path matching
# the glob GH_FAIL fails, as gh does when the API call does.
path=$2
if [[ -n ${GH_FAIL:-} && $path == $GH_FAIL ]]; then
  echo "gh: HTTP 502" >&2
  exit 1
fi
case $path in
  repos/o/r/deployments\?environment=dev\&sha=*) # the API's sha filter, on DEV_DEPLOYMENTS
    sha=${path#*sha=}
    sha=${sha%%&*}
    printf '%b' "$DEV_DEPLOYMENTS" | awk -v s="$sha" '$2 == s { print $1 }'
    ;;
  repos/o/r/deployments\?environment=dev*) printf '%b' "$DEV_DEPLOYMENTS" ;;
  repos/o/r/deployments/*/statuses*)
    id=${path#repos/o/r/deployments/}
    id=${id%%/*}
    if [[ $path == *per_page=100 ]]; then
      var=EVER_$id # any(.[]; .state == "success")
      echo "${!var:-false}"
    else
      var=STATE_$id # .[0].state, the latest
      echo "${!var:-}"
    fi
    ;;
  repos/o/r/compare/*)
    range=${path#repos/o/r/compare/}
    range=${range%%\?*}
    base=${range%%...*} head=${range#*...}
    if [[ $head == main ]]; then
      [[ $COMPARE == missing ]] && exit 1
      echo "$COMPARE"
    else # two commits: their places in MAIN_ORDER (oldest first, 40-hex shas)
      order=" $MAIN_ORDER "
      b=${order%% "$base" *} h=${order%% "$head" *}
      if [[ $b == "$order" || $h == "$order" ]]; then
        echo diverged
      elif ((${#h} > ${#b})); then
        echo ahead
      else
        echo behind
      fi
    fi
    ;;
  repos/o/r/actions/workflows/ci.yml/runs*) echo "$CI_RUNS" ;;
  repos/o/r/actions/workflows/rollback.yml/runs*) echo "$DEV_ROLLED_BACK_AT" ;; # after its --jq
  repos/o/r/commits/*) echo "feat: a | change (#1)" ;;
  *) echo "unexpected gh call: $*" >&2; exit 1 ;;
esac
echo "$*" >> "$GH_LOG"
"""


def run_step(
    step: dict[str, Any],
    tmp_path: Path,
    env: dict[str, str],
    fake: str,
    name: str,
    cwd: Path | None = None,
) -> tuple[subprocess.CompletedProcess[str], Path, Path]:
    bin_dir = tmp_path / "bin"
    bin_dir.mkdir(exist_ok=True)
    tool = bin_dir / name
    tool.write_text(fake)
    tool.chmod(0o755)
    output, summary = tmp_path / "output", tmp_path / "summary"
    output.touch()
    summary.touch()
    full_env = {
        "PATH": f"{bin_dir}:/usr/bin:/bin",
        "GITHUB_OUTPUT": str(output),
        "GITHUB_STEP_SUMMARY": str(summary),
        "GITHUB_SERVER_URL": "https://github.com",
        **env,
    }
    result = run_like_github(step, tmp_path, full_env, cwd)
    return result, output, summary


@pytest.mark.parametrize(
    ("overrides", "status", "outputs", "says"),
    [
        ({"INPUT_TAG": SHA}, 0, f"tag={SHA}\nfrom_dev=false\n", "the `tag` input"),
        # Empty input: dev's newest deployment that's still a success (11 is inactive).
        ({}, 0, f"tag={OTHER_SHA}\nfrom_dev=true\n", "the release dev runs now"),
        ({"GITHUB_REF": "refs/heads/topic"}, 1, "", "title=Not main"),
        ({"INPUT_TAG": SHA[:12]}, 1, "", "title=Bad tag"),
        ({"INPUT_TAG": SHA.upper()}, 1, "", "title=Bad tag"),
        ({"INPUT_TAG": f"{SHA};id"}, 1, "", "title=Bad tag"),
        ({"DEV_DEPLOYMENTS": ""}, 1, "", "title=Dev's release unknown"),
        ({"STATE_12": "failure", "STATE_11": "failure"}, 1, "", "title=Dev's release unknown"),
        # 11 reached success (inactive: superseded), 12 didn't: dev's release is SHA as far
        # as GitHub knows (the deploy job re-checks dev's record).
        ({"STATE_12": "failure"}, 0, f"tag={SHA}\nfrom_dev=true\n", "the release dev runs now"),
        ({"STATE_12": "in_progress"}, 0, f"tag={SHA}\nfrom_dev=true\n", "the release dev runs"),
        # #275: SHA's dev-deployment waited for a runner while OTHER_SHA deployed, so SHA's
        # deployment (13) was created last and OTHER_SHA's (12) went inactive. Dev runs
        # OTHER_SHA, the newer commit: the plan takes it, not the newest deployment.
        (
            {
                "DEV_DEPLOYMENTS": f"13 {SHA} {T3}\n12 {OTHER_SHA} {T2}\n",
                "STATE_13": "success",
                "STATE_12": "inactive",
            },
            0,
            f"tag={OTHER_SHA}\nfrom_dev=true\n",
            "the release dev runs now",
        ),
        # Dev ran THIRD_SHA, was rolled back at T3, then OTHER_SHA (older than THIRD_SHA, its
        # CI still running at the rollback) deployed: dev runs OTHER_SHA, and THIRD_SHA, the
        # release dev rolled back from, isn't offered.
        (
            {
                "DEV_DEPLOYMENTS": f"14 {OTHER_SHA} {T4}\n13 {THIRD_SHA} {T2}\n11 {SHA} {T1}\n",
                "STATE_14": "success",
                "STATE_13": "inactive",
                "EVER_14": "true",
                "DEV_ROLLED_BACK_AT": T3,
            },
            0,
            f"tag={OTHER_SHA}\nfrom_dev=true\n",
            "the release dev runs now",
        ),
        # Rolled back after its last deployment: what dev runs isn't known here. Stop
        # before the approval, not after it.
        ({"DEV_ROLLED_BACK_AT": T3}, 1, "", f"dev was rolled back (run finished {T3})"),
        ({"DEV_ROLLED_BACK_AT": "yesterday"}, 1, "", "title=Dev's release unknown"),
        # #283: each of dev_now's lookups that fails says which one did, before approval.
        (
            {"GH_FAIL": "*/rollback.yml/runs*"},
            1,
            "",
            "title=Dev's release unknown::listing dev's rollback runs failed",
        ),
        (
            {"GH_FAIL": "*/deployments?environment=dev&per_page=*"},
            1,
            "",
            "title=Dev's release unknown::listing dev's deployments failed",
        ),
        (
            {"GH_FAIL": "*/deployments/*/statuses?per_page=1"},
            1,
            "",
            "title=Dev's release unknown::reading a dev deployment's statuses failed",
        ),
        # A deployment of a commit off main (a force-push): no order, fail closed.
        (
            {
                "DEV_DEPLOYMENTS": f"13 {OFF_MAIN_SHA} {T3}\n12 {OTHER_SHA} {T2}\n",
                "STATE_13": "success",
            },
            1,
            "",
            "couldn't order dev's deployments",
        ),
        ({"DEV_DEPLOYMENTS": f"12 {OTHER_SHA} soon\n"}, 1, "", "title=Dev's release unknown"),
        ({"INPUT_TAG": SHA, "COMPARE": "diverged"}, 1, "", "title=Not on main"),
        ({"INPUT_TAG": SHA, "COMPARE": "behind"}, 1, "", "title=Not on main"),
        ({"INPUT_TAG": SHA, "COMPARE": "missing"}, 1, "", "title=Unknown commit"),
        ({"INPUT_TAG": SHA, "CI_RUNS": "0"}, 1, "", "title=CI not green"),
        # A tag must have a dev deployment that reached success (dev's smoke tests passed):
        # 11 was a success, then superseded (inactive), which counts.
        ({"INPUT_TAG": SHA, "EVER_11": "false"}, 1, "", "title=Not passed on dev"),
        ({"INPUT_TAG": THIRD_SHA}, 1, "", "title=Not passed on dev"),
        (
            {"INPUT_TAG": SHA, "EVER_11": "false", "DEV_DEPLOYMENTS": DEV_WITH_RETRY},
            0,
            f"tag={SHA}\nfrom_dev=false\n",
            "the `tag` input",
        ),
    ],
)
def test_deploy_prod_plan_picks_a_commit_on_main_that_passed_ci(
    prod_jobs: dict[str, Any],
    tmp_path: Path,
    overrides: dict[str, str],
    status: int,
    outputs: str,
    says: str,
) -> None:
    """The plan step, run with bash and a fake gh: the input or dev's current release,
    which must be a full sha on main with a green CI run on main. Dev's release is the
    newest commit (not the newest deployment) among its deployments that reached success
    since its last rollback (#275)."""
    step = step_named(prod_jobs["plan"], "Pick the commit")
    env = {
        "GH_REPO": "o/r",
        "GH_TOKEN": "not-a-token",
        "GH_LOG": str(tmp_path / "gh.log"),
        "GITHUB_REF": "refs/heads/main",
        "INPUT_TAG": "",
        "DEV_DEPLOYMENTS": f"12 {OTHER_SHA} {T2}\n11 {SHA} {T1}\n",
        "MAIN_ORDER": f"{SHA} {OTHER_SHA} {THIRD_SHA}",
        "DEV_ROLLED_BACK_AT": "",
        "STATE_12": "success",
        "STATE_11": "inactive",
        "EVER_12": "true",
        "EVER_11": "true",
        "EVER_10": "true",
        "COMPARE": "ahead",
        "CI_RUNS": "1",
        **overrides,
    }
    result, output, summary = run_step(step, tmp_path, env, FAKE_GH, "gh")
    assert result.returncode == status, result
    assert output.read_text() == outputs
    if status:
        assert says in result.stdout
    else:
        text = summary.read_text()
        assert says in text and f"Plan: deploy `{output.read_text()[4:44]}` to prod" in text
        assert "a \\| change" in text  # the subject can't break the Markdown


FAKE_SSH = r"""#!/usr/bin/env bash
# Fake ssh for the resolve step: prints $ANSWER, records the request.
echo "${*: -1}" >> "$SSH_LOG"
printf '%b' "$ANSWER"
"""


@pytest.mark.parametrize(
    ("from_dev", "answer_tag", "status", "sent", "says"),
    [
        ("true", SHA, 0, "candidate", ""),
        ("false", SHA, 0, f"candidate {SHA}", ""),
        ("true", OTHER_SHA, 1, "candidate", "title=Dev's record differs"),
    ],
)
def test_deploy_prod_resolves_the_digest_dev_ran(
    prod_jobs: dict[str, Any],
    tmp_path: Path,
    from_dev: str,
    answer_tag: str,
    status: int,
    sent: str,
    says: str,
) -> None:
    """Dev's current release when the plan took it from dev (and it must still be the
    one approved), else the last digest of that sha dev ran; the digest goes to DIGEST."""
    step = step_named(prod_jobs["deploy"], "Resolve the commit")
    github_env = tmp_path / "github_env"
    github_env.touch()
    env = {
        "TAG": SHA,
        "FROM_DEV": from_dev,
        "SSH_CONFIG": "/dev/null",
        "SSH_LOG": str(tmp_path / "ssh.log"),
        "RUNNER_TEMP": str(tmp_path),
        "GITHUB_ENV": str(github_env),
        "ANSWER": f"source=dev\ntag={answer_tag}\ndigest={DIGEST}\nsource_time=T\n",
    }
    result, output, _ = run_step(step, tmp_path, env, FAKE_SSH, "ssh")
    assert result.returncode == status, result
    assert (tmp_path / "ssh.log").read_text() == f"{sent}\n"
    assert says in result.stdout
    if status == 0:
        assert github_env.read_text() == f"DIGEST={DIGEST}\n"
        assert output.read_text() == "dev_time=T\n"
    else:
        assert github_env.read_text() == ""


# --- Deploy order on dev (#257) -------------------------------------------------------

ORDER_STEP = "Check this commit isn't older"
ORDER_GATE = "steps.order.outputs.deploy == 'true'"

FAKE_SSH_DEV = r"""#!/usr/bin/env bash
# Fake ssh for the order step: `status` prints dev's record (the tag in $DEV_STATE, if
# any; nothing on stdout without one, like focus-ci), or exits $SSH_RC. DEV_RECORD, when
# set (even empty), is printed as the record instead; DEV_STDERR goes to stderr first (an
# ssh warning, say).
request=${*: -1}
echo "$request" >> "$SSH_LOG"
[[ ${SSH_RC:-0} == 0 ]] || exit "$SSH_RC"
[[ $request == status ]] || exit 99
[[ -z ${DEV_STDERR:-} ]] || printf '%s\n' "$DEV_STDERR" >&2
if [[ -n ${DEV_RECORD+set} ]]; then
  printf '%b' "$DEV_RECORD"
elif [[ -s $DEV_STATE ]]; then
  printf 'env=dev\ntag=%s\ndigest=sha256:%064d\naction=deploy\n' "$(cat "$DEV_STATE")" 0
else
  echo "focus-ci: no release recorded for dev yet" >&2
fi
"""
NO_RECORD = "focus-ci: no release recorded for dev yet"
UNKNOWN = "reason=Dev's release unknown: "


def git(repo: Path, *args: str) -> str:
    result = subprocess.run(
        ["git", "-c", "user.name=t", "-c", "user.email=t@example.invalid", *args],
        cwd=repo,
        capture_output=True,
        text=True,
        check=True,
    )
    return result.stdout.strip()


@pytest.fixture(scope="module")
def main_history(tmp_path_factory: pytest.TempPathFactory) -> tuple[Path, list[str]]:
    """A linear main like the job's checkout (fetch-depth: 0): five squash commits, oldest
    first. The last one is a revert of the one before (newer, so it deploys)."""
    repo = tmp_path_factory.mktemp("main")
    git(repo, "init", "-q", "-b", "main")
    shas = []
    for n in range(4):
        (repo / f"f{n}").write_text(f"{n}\n")
        git(repo, "add", f"f{n}")
        git(repo, "commit", "-q", "-m", f"change {n}")
        shas.append(git(repo, "rev-parse", "HEAD"))
    git(repo, "revert", "--no-edit", "HEAD")
    shas.append(git(repo, "rev-parse", "HEAD"))
    return repo, shas


def run_order(
    jobs: dict[str, Any], tmp_path: Path, repo: Path, tag: str, dev_runs: str, **env: str
) -> tuple[subprocess.CompletedProcess[str], Path, Path]:
    state = tmp_path / "dev_state"
    state.write_text(dev_runs)
    for name in ("output", "summary", "ssh.log"):
        (tmp_path / name).unlink(missing_ok=True)
    full_env = {
        "TAG": tag,
        "SSH_CONFIG": "/dev/null",
        "SSH_LOG": str(tmp_path / "ssh.log"),
        "DEV_STATE": str(state),
        "RUNNER_TEMP": str(tmp_path),
        **env,
    }
    step = step_named(jobs["deploy-dev"], ORDER_STEP)
    return run_step(step, tmp_path, full_env, FAKE_SSH_DEV, "ssh", cwd=repo)


@pytest.mark.parametrize(
    ("tag", "dev_runs", "fake", "status", "outputs", "says"),
    [
        # #257: an older commit's run reaches the group after a newer one deployed.
        (0, 2, {}, 0, "deploy=false\n", "::notice title=Dev deploy skipped::"),
        (1, 2, {}, 0, "deploy=false\n", "::notice title=Dev deploy skipped::"),
        (2, 0, {}, 0, "deploy=true\n", ""),  # newer: deploys
        (3, 2, {}, 0, "deploy=true\n", ""),
        (4, 3, {}, 0, "deploy=true\n", ""),  # a revert commit is newer: deploys
        (2, 2, {}, 0, "deploy=true\n", ""),  # the same commit again (a re-run): deploys
        # Dev has no release yet, focus-ci's real answer (nothing on stdout, its line on
        # stderr): a first deploy, also with an ssh warning before it.
        (2, None, {}, 0, "deploy=true\n", ""),
        (2, None, {"DEV_STDERR": "Warning: a line from ssh"}, 0, "deploy=true\n", ""),
        (2, "f" * 40, {}, 1, "reason=Deploy order unknown: ", "title=Deploy order unknown"),
        (2, "abc", {}, 1, UNKNOWN, "title=Dev's release unknown"),  # malformed record
        # #275: only that exact answer is a first deploy. A record that exists but is empty
        # or has no tag= line, or an empty answer without focus-ci's line, fails red.
        (2, None, {"DEV_RECORD": ""}, 1, UNKNOWN, "has no tag."),
        (2, None, {"DEV_RECORD": "env=dev\ndigest=sha256:0\n"}, 1, UNKNOWN, "has no tag."),
        (2, None, {"DEV_RECORD": "\n"}, 1, UNKNOWN, "has no tag."),
        (
            2,
            None,
            {"DEV_RECORD": "", "DEV_STDERR": NO_RECORD.replace("dev", "prod")},
            1,
            UNKNOWN,
            "has no tag.",
        ),
        (
            2,
            None,
            {"DEV_RECORD": "env=dev\n", "DEV_STDERR": NO_RECORD},
            1,
            UNKNOWN,
            "has no tag.",
        ),
        (2, None, {"DEV_RECORD": "tag=\n"}, 1, UNKNOWN, "has no tag."),
    ],
    ids=[
        "oldest-after-newest",
        "older-after-newer",
        "newer",
        "next",
        "revert-commit",
        "same-commit",
        "first-deploy",
        "first-deploy-with-ssh-warning",
        "unknown-commit",
        "malformed-record",
        "empty-record",
        "record-without-tag",
        "blank-record",
        "no-record-message-of-another-env",
        "no-record-message-with-a-record",
        "empty-tag",
    ],
)
def test_order_step_skips_an_older_commit_and_deploys_a_newer_one(
    jobs: dict[str, Any],
    tmp_path: Path,
    main_history: tuple[Path, list[str]],
    tag: int,
    dev_runs: int | str | None,
    fake: dict[str, str],
    status: int,
    outputs: str,
    says: str,
) -> None:
    """The order step, run as GitHub runs it in a checkout of main with a fake ssh: an
    ancestor of the commit dev runs skips green with a notice and a summary; the same
    commit, a newer one or a first deploy goes on; anything it can't place fails red,
    with its reason in the `reason` output for the Summary (#275). It only ever sends
    `status`, so dev's record is unchanged by it."""
    repo, shas = main_history
    current = shas[dev_runs] if isinstance(dev_runs, int) else (dev_runs or "")
    result, output, summary = run_order(jobs, tmp_path, repo, shas[tag], current, **fake)
    assert result.returncode == status, result
    if status:
        assert output.read_text().startswith(outputs)
        assert output.read_text().count("\n") == 1
    else:
        assert output.read_text() == outputs
    assert says in result.stdout
    assert fake.get("DEV_STDERR", "") in result.stderr  # the server's lines stay in the log
    assert (tmp_path / "ssh.log").read_text() == "status\n"
    assert (tmp_path / "dev_state").read_text() == current
    if outputs == "deploy=false\n":
        text = summary.read_text()
        assert "Deploy to dev: skipped, dev runs a newer commit" in text
        assert current in text and shas[tag] in text


def test_order_step_fails_when_dev_cant_be_read(
    jobs: dict[str, Any], tmp_path: Path, main_history: tuple[Path, list[str]]
) -> None:
    repo, shas = main_history
    result, output, _ = run_order(jobs, tmp_path, repo, shas[2], shas[1], SSH_RC="255")
    assert result.returncode == 1, result
    assert "title=Dev's release unknown" in result.stdout
    reason = "couldn't read dev's release record (ssh status failed)."
    assert output.read_text() == f"{UNKNOWN}{reason}\n"


def test_first_deploy_answer_is_focus_ci_s_own(jobs: dict[str, Any]) -> None:
    """The order step takes a first deploy only on the exact line focus-ci's `status`
    prints for an environment with no record, with the dev profile's environment name."""
    script = FOCUS_CI.read_text()
    status = re.search(r"^do_status\(\) \{\n(.*?)^\}", script, re.S | re.M)
    assert status
    assert 'echo "focus-ci: no release recorded for $env_name yet" >&2' in status.group(1)
    profile = re.search(r"^  dev\)\n(.*?);;", script, re.S | re.M)
    assert profile and "env_name=dev" in profile.group(1)
    assert f'grep -Fqx "{NO_RECORD}"' in step_named(jobs["deploy-dev"], ORDER_STEP)["run"]


def test_unknown_order_points_at_the_recovery(jobs: dict[str, Any]) -> None:
    """Dev runs a commit missing from main's history: the error says how to get out (#275),
    and deployment.md's Deploy order section has the steps."""
    run = step_named(jobs["deploy-dev"], ORDER_STEP)["run"]
    assert "Roll dev back to a release on main, then re-run this job" in run
    docs = (REPO / "_docs" / "deployment.md").read_text()
    section = docs.split("### Deploy order (#257)", 1)[1].split("\n### ", 1)[0]
    assert "rollback.yml" in section and "runbooks/rollback.md" in section


def test_merges_finishing_out_of_order_leave_dev_on_the_newest(
    jobs: dict[str, Any], tmp_path: Path, main_history: tuple[Path, list[str]]
) -> None:
    """The 2026-10-25 timeline from #257: three merges whose deploy jobs ran middle,
    newest, oldest. Each run's order step decides; a `deploy=true` stands for the deploy
    that follows (it records the tag). Dev ends on the newest, and a revert merged
    afterwards still deploys."""
    repo, shas = main_history
    dev_runs = shas[0]
    deployed = []
    for tag in (shas[2], shas[3], shas[1], shas[4]):
        result, output, _ = run_order(jobs, tmp_path, repo, tag, dev_runs)
        assert result.returncode == 0, result
        if output.read_text() == "deploy=true\n":
            dev_runs = tag
            deployed.append(tag)
    assert deployed == [shas[2], shas[3], shas[4]]
    assert dev_runs == shas[4]


def test_deploy_dev_checks_order_inside_its_group_before_deploying(jobs: dict[str, Any]) -> None:
    """The order step reads dev with the key, before the deploy request, in a checkout
    with main's history; every step after it that touches dev or reports a deploy runs
    only when it let the commit through. The Summary also runs when a check before it
    failed (no output), but not after a skip, which wrote its own summary."""
    job = jobs["deploy-dev"]
    steps = job["steps"]
    names = [str(step.get("name", step.get("uses"))) for step in steps]
    order = names.index(step_named(job, ORDER_STEP)["name"])
    assert names.index(step_named(job, "Set up the deploy key")["name"]) < order
    assert order < names.index(step_named(job, "Deploy over SSH")["name"])
    assert steps[order]["id"] == "order"
    assert steps[order]["if"] == "steps.config.outputs.configured == 'true'"
    assert "git merge-base --is-ancestor" in steps[order]["run"]
    checkout = next(s for s in steps if str(s.get("uses", "")).startswith("actions/checkout@"))
    assert checkout["with"]["fetch-depth"] == 0
    assert steps.index(checkout) < order
    for step in steps[order + 1 :]:
        condition = str(step.get("if", ""))
        if step.get("name") == "Summary":
            assert "steps.order.outputs.deploy != 'false'" in condition
        else:
            assert ORDER_GATE in condition or condition == "always()", step
    assert job["outputs"]["deployed"] == "${{ steps.order.outputs.deploy }}"
    # The check holds until the deploy because only this group's jobs move dev forward.
    assert job["concurrency"] == {"group": "deploy-dev", "cancel-in-progress": False}


def test_dev_deployment_is_created_only_after_a_real_deploy(jobs: dict[str, Any]) -> None:
    """The `dev` GitHub deployment, which deploy-prod's plan reads as what dev ran, comes
    from a job that runs only when deploy-dev passed and deployed (not after a skip),
    with no token permissions, no secret and no repository code."""
    record = jobs["dev-deployment"]
    assert record["needs"] == "deploy-dev"
    assert record["if"] == f"{MAIN_PUSH_ONLY} && needs.deploy-dev.outputs.deployed == 'true'"
    assert record["environment"] == {"name": "dev", "url": "https://dev.ineedtofoc.us"}
    assert record["permissions"] == {}
    assert "secrets." not in yaml.safe_dump(record)
    assert all("uses" not in step for step in record["steps"])
    # deploy-dev's own job creates none, and nothing else deploys to dev.
    in_dev = [
        name
        for name, job in jobs.items()
        if isinstance(job.get("environment"), dict)
        and job["environment"].get("name") == "dev"
        and job["environment"].get("deployment", True)
    ]
    assert in_dev == ["dev-deployment"]


def test_rollback_has_no_order_check() -> None:
    """A deliberate rollback goes back on purpose: rollback.yml never compares commits."""
    assert "merge-base" not in (WORKFLOWS / "rollback.yml").read_text()


def run_dev_summary(
    jobs: dict[str, Any], tmp_path: Path, **env: str
) -> tuple[subprocess.CompletedProcess[str], str]:
    """deploy-dev's Summary step with the given step outcomes (skipped by default)."""
    summary_step = step_named(jobs["deploy-dev"], "Summary")
    full_env = {
        "DEV_URL": "https://dev.ineedtofoc.us",
        "TAG": SHA,
        "DIGEST": DIGEST,
        "RUNNER_TEMP": str(tmp_path),
        "PROVENANCE_OUTCOME": "success",
        "ORDER_OUTCOME": "success",
        "ORDER_REASON": "",
        "DEPLOY_OUTCOME": "skipped",
        "SMOKE_OUTCOME": "skipped",
        **env,
    }
    (tmp_path / "summary").unlink(missing_ok=True)
    result, _, summary = run_step(summary_step, tmp_path, full_env, "#!/bin/sh\n", "unused")
    return result, summary.read_text()


def test_summary_says_why_after_a_failed_order_check(
    jobs: dict[str, Any], tmp_path: Path, main_history: tuple[Path, list[str]]
) -> None:
    """#275: the order step fails on a record without a tag; the Summary, which still runs,
    says nothing was deployed and why, from the step's `reason` output."""
    summary_step = step_named(jobs["deploy-dev"], "Summary")
    assert summary_step["env"]["ORDER_OUTCOME"] == "${{ steps.order.outcome }}"
    assert summary_step["env"]["ORDER_REASON"] == "${{ steps.order.outputs.reason }}"
    repo, shas = main_history
    order_dir = tmp_path / "order"
    order_dir.mkdir()
    result, output, _ = run_order(jobs, order_dir, repo, shas[2], "", DEV_RECORD="env=dev\n")
    assert result.returncode == 1, result
    reason = output.read_text().removeprefix("reason=").strip()
    result, text = run_dev_summary(jobs, tmp_path, ORDER_OUTCOME="failure", ORDER_REASON=reason)
    assert result.returncode == 0, result
    assert "### Deploy to dev: skipped, smoke tests: skipped" in text
    assert (
        "Not deployed: the order check failed, see its log (#257). "
        "Dev's release unknown: dev's release record has no tag.\n"
    ) in text
    # A step that died without a reason still gets the line.
    _, text = run_dev_summary(jobs, tmp_path, ORDER_OUTCOME="failure")
    assert "Not deployed: the order check failed, see its log (#257).\n" in text
    # A deploy that got through the check doesn't.
    _, text = run_dev_summary(jobs, tmp_path, DEPLOY_OUTCOME="success", SMOKE_OUTCOME="success")
    assert "order check failed" not in text and "Deploy to dev: deployed" in text


# --- deploy-prod's plan and dev's rollbacks (#275) -------------------------------------


def test_plan_finds_dev_rollbacks_by_the_rollback_run_name(prod_jobs: dict[str, Any]) -> None:
    """The plan's cutoff finds dev's rollback runs by their run name. Run its jq on runs
    like GitHub's: the latest dev one counts, prod ones and other workflows' names don't."""
    rollback = load_workflow(ROLLBACK)
    assert rollback["run-name"].startswith("Roll back ${{ inputs.env }} to ")
    triggers: dict[str, Any] = rollback.get("on", rollback.get(True)) or {}
    assert "dev" in triggers["workflow_dispatch"]["inputs"]["env"]["options"]
    run = step_named(prod_jobs["plan"], "Pick the commit")["run"]
    found = re.search(r"actions/workflows/rollback\.yml/runs\?[^\"]*\" \\\n\s+--jq '([^']+)'", run)
    assert found, "the plan's rollback query moved"
    assert "branch=main&event=workflow_dispatch" in found.group(0)
    jq = shutil.which("jq")
    assert jq, "this test needs jq"
    runs = {
        "workflow_runs": [
            {"display_title": "Roll back prod to the last known-good release", "updated_at": T4},
            {"display_title": f"Roll back dev to {SHA}", "updated_at": T2},
            {"display_title": "Roll back dev to the last known-good release", "updated_at": T3},
            {"display_title": "Roll back development", "updated_at": T4},
        ]
    }

    def latest(data: dict[str, Any]) -> str:
        out = subprocess.run(
            [jq, "-r", found.group(1)], input=json.dumps(data), capture_output=True, text=True
        )
        assert out.returncode == 0, out
        return out.stdout.strip()

    assert latest(runs) == T3
    assert latest({"workflow_runs": runs["workflow_runs"][:1]}) == ""
    assert latest({"workflow_runs": []}) == ""


# --- Dev catching up with main (#275) ---------------------------------------------------

CATCH_UP_STEP = "Flag a newer commit whose Deploy to dev was cancelled"

FAKE_GH_JSON = r"""#!/usr/bin/env bash
# Fake `gh api <path> --jq <expr>`: the JSON file $GH_JSON/<path, with / ? & = as _>, run
# through the real jq like gh's --jq. No such file: gh fails (exit 1).
path=$2 expr=""
args=("$@")
for ((i = 0; i < ${#args[@]}; i++)); do
  [[ ${args[i]} == --jq ]] && expr=${args[i + 1]}
done
echo "$path" >> "$GH_LOG"
file=$GH_JSON/$(printf '%s' "$path" | tr '/?&=' '____')
[[ -f $file ]] || { echo "gh: HTTP 404 for $path" >&2; exit 1; }
"$JQ" -r "$expr" "$file"
"""

HEAD_SHA = "f" * 40
HEAD_RUN = 4242
HEAD_JOB = 777
HEAD_RUNS_QUERY = "event=push&branch=main&per_page=1"


def gh_json_name(path: str) -> str:
    return path.translate(str.maketrans("/?&=", "____"))


def run_catch_up(
    jobs: dict[str, Any], tmp_path: Path, answers: dict[str, Any], tag: str = SHA
) -> tuple[subprocess.CompletedProcess[str], str, list[str]]:
    answers_dir = tmp_path / "gh"
    answers_dir.mkdir()
    for path, body in answers.items():
        (answers_dir / gh_json_name(path)).write_text(json.dumps(body))
    jq = shutil.which("jq")
    assert jq, "this test needs jq"
    env = {
        "GH_TOKEN": "not-a-token",
        "GH_REPO": "o/r",
        "TAG": tag,
        "GH_JSON": str(answers_dir),
        "GH_LOG": str(tmp_path / "gh.log"),
        "JQ": jq,
    }
    step = step_named(jobs["dev-catch-up"], CATCH_UP_STEP)
    result, _, summary = run_step(step, tmp_path, env, FAKE_GH_JSON, "gh")
    log = tmp_path / "gh.log"
    return result, summary.read_text(), log.read_text().splitlines() if log.exists() else []


def head_answers(
    order: str = "ahead", runs: list[dict[str, Any]] | None = None, jobs: Any = None
) -> dict[str, Any]:
    """main's head is HEAD_SHA, `order` relative to SHA; its CI run and that run's jobs."""
    answers: dict[str, Any] = {
        "repos/o/r/commits/main": {"sha": HEAD_SHA},
        f"repos/o/r/compare/{SHA}...{HEAD_SHA}?per_page=1": {"status": order},
        f"repos/o/r/actions/workflows/ci.yml/runs?head_sha={HEAD_SHA}&{HEAD_RUNS_QUERY}": {
            "workflow_runs": [{"id": HEAD_RUN}] if runs is None else runs
        },
    }
    if jobs is not None:
        path = f"repos/o/r/actions/runs/{HEAD_RUN}/jobs?filter=latest&per_page=100"
        answers[path] = {"jobs": jobs}
    return answers


def deploy_job(status: str, conclusion: str | None) -> list[dict[str, Any]]:
    return [
        {"id": 1, "name": "Publish image to GHCR", "status": "completed", "conclusion": "success"},
        {"id": HEAD_JOB, "name": "Deploy to dev", "status": status, "conclusion": conclusion},
    ]


@pytest.mark.parametrize(
    ("answers", "flagged"),
    [
        # #275: this older commit's deploy replaced main's head's pending one, which shows
        # as cancelled. Dev lags main until someone re-runs it: flag it.
        (head_answers(jobs=deploy_job("completed", "cancelled")), True),
        # main's head still deploys on its own (waiting, running, done) or never will (a red
        # main): nothing to flag.
        (head_answers(jobs=deploy_job("queued", None)), False),
        (head_answers(jobs=deploy_job("waiting", None)), False),
        (head_answers(jobs=deploy_job("in_progress", None)), False),
        (head_answers(jobs=deploy_job("completed", "success")), False),
        (head_answers(jobs=deploy_job("completed", "skipped")), False),
        (head_answers(jobs=deploy_job("completed", "failure")), False),
        (head_answers(jobs=deploy_job("completed", "cancelled")[:1]), False),  # not created yet
        (head_answers(runs=[]), False),  # its CI hasn't started
        (head_answers(order="behind"), False),
        ({"repos/o/r/commits/main": {"sha": SHA}}, False),  # this commit is main's head
    ],
    ids=[
        "head-cancelled",
        "head-queued",
        "head-waiting",
        "head-running",
        "head-deployed",
        "head-skipped",
        "head-failed",
        "head-job-not-created",
        "head-no-run",
        "head-not-newer",
        "this-is-head",
    ],
)
def test_catch_up_flags_a_newer_commit_whose_deploy_was_cancelled(
    jobs: dict[str, Any], tmp_path: Path, answers: dict[str, Any], flagged: bool
) -> None:
    result, summary, _ = run_catch_up(jobs, tmp_path, answers)
    assert result.returncode == 0, result
    if flagged:
        assert "::warning title=Dev is behind main::" in result.stdout
        assert summary.startswith("### Dev is behind main\n\n")
        assert HEAD_SHA in summary
        assert f"https://github.com/o/r/actions/runs/{HEAD_RUN}/job/{HEAD_JOB}" in summary
        assert f"gh run rerun --job {HEAD_JOB}" in summary
    else:
        assert "::warning" not in result.stdout and summary == ""


@pytest.mark.parametrize("missing", [0, 1, 2, 3])
def test_catch_up_never_fails_the_run(jobs: dict[str, Any], tmp_path: Path, missing: int) -> None:
    """A lookup that fails (the API is down, say) is a warning, never a red run: dev's
    deploy already happened, and dev-deployment doesn't depend on this job."""
    answers = head_answers(jobs=deploy_job("completed", "cancelled"))
    del answers[list(answers)[missing]]
    result, summary, _ = run_catch_up(jobs, tmp_path, answers)
    assert result.returncode == 0, result
    assert "::warning title=Dev catch-up not checked::" in result.stdout
    assert summary == ""


def test_catch_up_rejects_odd_answers(jobs: dict[str, Any], tmp_path: Path) -> None:
    """What reaches a workflow command or a URL is checked first: a head that isn't a sha
    (a workflow command, say) is never echoed."""
    answers = {"repos/o/r/commits/main": {"sha": "::error::x"}}
    result, summary, _ = run_catch_up(jobs, tmp_path, answers)
    assert result.returncode == 0, result
    assert "::error::x" not in result.stdout
    assert "::warning title=Dev catch-up not checked::" in result.stdout and summary == ""


@pytest.mark.parametrize(
    ("runs", "job_id"),
    [([{"id": "::error::run"}], HEAD_JOB), (None, "::error::job")],
    ids=["run-id", "job-id"],
)
def test_catch_up_rejects_ids_that_arent_numbers(
    jobs: dict[str, Any], tmp_path: Path, runs: list[dict[str, Any]] | None, job_id: Any
) -> None:
    """#283: a run id or job id that isn't a number is a warning (exit 0), never echoed
    or put in a URL: the run's jobs aren't listed with a bad run id, and a bad job id
    isn't flagged."""
    job = deploy_job("completed", "cancelled")
    job[-1]["id"] = job_id
    result, summary, log = run_catch_up(jobs, tmp_path, head_answers(runs=runs, jobs=job))
    assert result.returncode == 0, result
    bad = runs[0]["id"] if runs else job_id
    assert bad not in result.stdout and bad not in result.stderr
    assert "::warning title=Dev catch-up not checked::" in result.stdout and summary == ""
    if runs:
        assert "unexpected run id" in result.stdout
        assert not any("/jobs?" in call for call in log)
    else:
        assert "unexpected job id" in result.stdout


def test_catch_up_job_runs_after_every_deploy_dev_that_got_past_the_order_check(
    jobs: dict[str, Any],
) -> None:
    """It runs in the run whose deploy replaced the newer pending one, whether that deploy
    went ahead or skipped for order, with read-only API access only: no environment, no
    secret, no checkout, no re-run (that would need actions: write, #275)."""
    job = jobs["dev-catch-up"]
    assert job["needs"] == "deploy-dev"
    assert job["if"] == (
        f"${{{{ !cancelled() && {MAIN_PUSH_ONLY} && needs.deploy-dev.outputs.deployed != '' }}}}"
    )
    assert job["permissions"] == {"contents": "read", "actions": "read"}
    assert "environment" not in job and "concurrency" not in job
    assert "secrets." not in yaml.safe_dump(job)
    assert all("uses" not in step for step in job["steps"])
    run = step_named(job, CATCH_UP_STEP)["run"]
    assert "exit 1" not in run and "rerun" not in run.replace("gh run rerun --job", "")
    # It finds deploy-dev's job by its name.
    assert f'select(.name == "{jobs["deploy-dev"]["name"]}")' in run


# --- Build provenance (#128) ----------------------------------------------------------

IMAGE_NAME = "ghcr.io/ybenzine/ineedtofocus"
RUN_URL = "https://github.com/ybenzine/ineedtofocus/actions/runs/123/attempts/1"
VERIFY_STEP = "Verify the image's build provenance"
# The exact gh call both verify steps make, one argument per line in the fake's log: this
# repository's attestations of exactly that digest, signed by ci.yml at the approved
# commit, built for a push to main from that commit, on a GitHub-hosted runner.
VERIFY_ARGV = [
    "attestation",
    "verify",
    f"oci://{IMAGE_NAME}@{DIGEST}",
    "--repo",
    "ybenzine/ineedtofocus",
    "--signer-workflow",
    "ybenzine/ineedtofocus/.github/workflows/ci.yml",
    "--signer-digest",
    SHA,
    "--source-ref",
    "refs/heads/main",
    "--source-digest",
    SHA,
    "--predicate-type",
    "https://slsa.dev/provenance/v1",
    "--deny-self-hosted-runners",
    "--format",
    "json",
    "--jq",
    ".[0].verificationResult.signature.certificate.runInvocationURI",
]


def effective_permissions(path: Path) -> list[tuple[str, dict[str, str]]]:
    """Each job's token permissions: its own block, else the workflow's. Every workflow
    sets one, as a map (never `write-all` or the repository default)."""
    data: dict[Any, Any] = yaml.safe_load(path.read_text())
    top = data.get("permissions")
    assert isinstance(top, dict), path.name
    result = []
    for name, job in data["jobs"].items():
        own = job.get("permissions", top)
        assert isinstance(own, dict), (path.name, name)
        result.append((name, own))
    return result


@pytest.mark.parametrize("scope", ["id-token", "attestations"])
def test_only_publish_can_sign_and_store_attestations(scope: str) -> None:
    """`id-token: write` (a Sigstore certificate in this repository's name) and
    `attestations: write` belong to ci.yml's publish job alone, across every workflow."""
    writers = [
        (path.name, name)
        for path in all_workflows()
        for name, permissions in effective_permissions(path)
        if permissions.get(scope) == "write"
    ]
    assert writers == [("ci.yml", "publish")]


def test_publish_permissions_are_exactly_these(jobs: dict[str, Any]) -> None:
    assert jobs["publish"]["permissions"] == {
        "contents": "read",
        "packages": "write",
        "id-token": "write",
        "attestations": "write",
    }


def test_publish_attests_the_digest_it_pushed(jobs: dict[str, Any]) -> None:
    """actions/attest-build-provenance, pinned by sha, for the pushed digest (not the tag),
    stored next to the image too, after the push and while still logged in to GHCR."""
    steps = jobs["publish"]["steps"]
    attest = step_named(jobs["publish"], "Attest build provenance")
    assert re.fullmatch(r"actions/attest-build-provenance@[0-9a-f]{40}", attest["uses"])
    assert attest["with"] == {
        "subject-name": IMAGE_NAME,
        "subject-digest": "${{ steps.push.outputs.digest }}",
        "push-to-registry": True,
        "create-storage-record": False,
    }
    assert "if" not in attest and "continue-on-error" not in attest
    push = next(i for i, step in enumerate(steps) if step.get("id") == "push")
    assert push < steps.index(attest)
    assert "docker logout" not in steps[push]["run"]
    logout = step_named(jobs["publish"], "Log out of GHCR")
    assert logout == {
        "name": "Log out of GHCR",
        "if": "always()",
        "run": "docker logout ghcr.io",
        "_shell": None,
    }
    assert steps.index(attest) < steps.index(logout) == len(steps) - 1
    # The version comment (test_actions_are_pinned_to_a_commit checks its shape).
    assert re.search(r"actions/attest-build-provenance@[0-9a-f]{40} # v4\.", CI.read_text())


def verify_jobs(jobs: dict[str, Any], prod_jobs: dict[str, Any]) -> dict[str, dict[str, Any]]:
    return {"deploy-dev": jobs["deploy-dev"], "deploy-prod": prod_jobs["deploy"]}


def test_both_deploys_verify_with_the_same_script(
    jobs: dict[str, Any], prod_jobs: dict[str, Any]
) -> None:
    """One script, so dev never records a digest prod's check would refuse."""
    dev, prod = (step_named(job, VERIFY_STEP) for job in verify_jobs(jobs, prod_jobs).values())
    assert dev["run"] == prod["run"]
    for step in (dev, prod):
        assert step["id"] == "provenance"
        assert step["if"] == "steps.config.outputs.configured == 'true'"
        assert step["env"] == {"GH_TOKEN": "${{ github.token }}"}
        assert "continue-on-error" not in step
        assert "ssh" not in step["run"] and "scripts/" not in step["run"]
        # The pins, as written in the workflow.
        for flag in [
            'gh attestation verify "oci://ghcr.io/ybenzine/ineedtofocus@$DIGEST"',
            "--repo ybenzine/ineedtofocus \\",
            "--signer-workflow ybenzine/ineedtofocus/.github/workflows/ci.yml \\",
            '--signer-digest "$TAG" \\',
            "--source-ref refs/heads/main \\",
            '--source-digest "$TAG" \\',
            "--predicate-type https://slsa.dev/provenance/v1 \\",
            "--deny-self-hosted-runners \\",
        ]:
            assert flag in step["run"], flag


@pytest.mark.parametrize("workflow_job", ["deploy-dev", "deploy-prod"])
def test_a_failed_verify_stops_the_job_before_any_deploy_request(
    jobs: dict[str, Any], prod_jobs: dict[str, Any], workflow_job: str
) -> None:
    """The verify step comes before the SSH deploy request, and every step from it up to
    that request runs only if all before it succeeded (no always(), failure() or
    !cancelled()), so a refused attestation means no `deploy` reaches the server. On
    prod it comes after `candidate`, which reads the digest; on dev, before the key is
    written."""
    job = verify_jobs(jobs, prod_jobs)[workflow_job]
    steps = job["steps"]
    names = [str(step.get("name", step.get("uses"))) for step in steps]
    verify = names.index(step_named(job, VERIFY_STEP)["name"])
    deploy = names.index(step_named(job, "Deploy over SSH")["name"])
    assert verify < deploy
    assert not any('"deploy ' in str(step.get("run", "")) for step in steps[:verify])
    for step in steps[verify : deploy + 1]:
        condition = str(step.get("if", ""))
        assert not re.search(r"always\(\)|failure\(\)|cancelled\(\)", condition), step
        assert "continue-on-error" not in step, step
    if workflow_job == "deploy-prod":
        assert names.index(step_named(job, "Resolve the commit")["name"]) < verify
    else:
        assert verify < names.index(step_named(job, "Set up the deploy key")["name"])


FAKE_GH_ATTEST = r"""#!/usr/bin/env bash
# Fake gh for the verify step: logs its arguments one per line, then answers like
# `gh attestation verify … --format json --jq <run URL>` (exit 0), or refuses (exit 1).
printf '%s\n' "$@" > "$GH_LOG"
if [[ $GH_STATUS != 0 ]]; then
  echo "$GH_ERROR" >&2
  exit "$GH_STATUS"
fi
printf '%s\n' "$GH_ANSWER"
"""


@pytest.mark.parametrize("workflow_job", ["deploy-dev", "deploy-prod"])
@pytest.mark.parametrize(
    ("overrides", "status", "built_by", "says"),
    [
        ({}, 0, RUN_URL, f"was built from {SHA} by {RUN_URL}"),
        # No attestation at all: an image pushed outside publish, or published before #128.
        (
            {"GH_STATUS": "1", "GH_ERROR": "Error: HTTP 404: Not Found"},
            1,
            None,
            "title=Build provenance not verified",
        ),
        # An attestation, but not for this commit (or ref, or workflow): gh refuses.
        (
            {
                "GH_STATUS": "1",
                "GH_ERROR": f"Error: expected SourceRepositoryDigest to be {SHA}, got {OTHER_SHA}",
            },
            1,
            None,
            "title=Build provenance not verified",
        ),
        # Verified, but the run URL isn't the expected shape: verified, no link.
        ({"GH_ANSWER": "https://evil.example/x|y"}, 0, "", "by a ci.yml run on main"),
        ({"DIGEST": "sha256:" + "C" * 64}, 1, None, "::error::bad tag or digest"),
        ({"DIGEST": DIGEST[:-1]}, 1, None, "::error::bad tag or digest"),
        ({"TAG": SHA[:12]}, 1, None, "::error::bad tag or digest"),
        ({"TAG": ""}, 1, None, "::error::bad tag or digest"),
    ],
    ids=[
        "attested",
        "no-attestation",
        "other-commit",
        "odd-run-url",
        "uppercase-digest",
        "short-digest",
        "short-tag",
        "empty-tag",
    ],
)
def test_verify_step_passes_only_an_attestation_gh_accepts(
    jobs: dict[str, Any],
    prod_jobs: dict[str, Any],
    tmp_path: Path,
    workflow_job: str,
    overrides: dict[str, str],
    status: int,
    built_by: str | None,
    says: str,
) -> None:
    """The verify step, run as GitHub runs it with a fake gh: exactly the pinned call;
    gh's refusal fails the step with an error (so the job stops before `deploy`); a bad
    tag or digest never reaches gh."""
    step = step_named(verify_jobs(jobs, prod_jobs)[workflow_job], VERIFY_STEP)
    gh_log = tmp_path / "gh.log"
    env = {
        "TAG": SHA,
        "DIGEST": DIGEST,
        "GH_TOKEN": "not-a-token",
        "GH_LOG": str(gh_log),
        "GH_STATUS": "0",
        "GH_ERROR": "",
        "GH_ANSWER": RUN_URL,
        **overrides,
    }
    result, output, _ = run_step(step, tmp_path, env, FAKE_GH_ATTEST, "gh")
    assert result.returncode == status, result
    assert says in result.stdout
    if "bad tag or digest" in says:
        assert not gh_log.exists()
    else:
        assert gh_log.read_text().splitlines() == VERIFY_ARGV
    if built_by is None:
        assert output.read_text() == ""
    else:
        assert output.read_text() == f"built_by={built_by}\n"
    if status and "bad tag" not in says:
        assert env["GH_ERROR"] in result.stderr  # gh's reason stays in the log


@pytest.mark.parametrize("workflow_job", ["deploy-dev", "deploy-prod"])
def test_summary_reports_the_provenance(
    jobs: dict[str, Any], prod_jobs: dict[str, Any], workflow_job: str
) -> None:
    summary = step_named(verify_jobs(jobs, prod_jobs)[workflow_job], "Summary")
    assert summary["env"]["PROVENANCE_OUTCOME"] == "${{ steps.provenance.outcome }}"
    assert summary["env"]["BUILT_BY"] == "${{ steps.provenance.outputs.built_by }}"
    assert "| Build provenance |" in summary["run"]
    assert "$PROVENANCE_OUTCOME == failure" in summary["run"]


# --- rollback.yml (#30) ---------------------------------------------------------------

ROLLBACK = WORKFLOWS / "rollback.yml"
ROLLBACK_ENVIRONMENT = "${{ inputs.env == 'prod' && 'rollback' || 'dev' }}"


@pytest.fixture(scope="module")
def rollback_workflow() -> dict[Any, Any]:
    data: dict[Any, Any] = load_workflow(ROLLBACK)
    return data


@pytest.fixture(scope="module")
def rollback_job(rollback_workflow: dict[Any, Any]) -> dict[str, Any]:
    job: dict[str, Any] = rollback_workflow["jobs"]["rollback"]
    return job


def test_rollback_file_is_the_one_the_allow_rule_names(rollback_workflow: dict[Any, Any]) -> None:
    """`gh workflow run rollback.yml …` is pre-approved, so on-call never stalls (#53)."""
    assert ROLLBACK in all_workflows()
    assert rollback_workflow["name"] == "rollback"
    settings = json.loads((REPO / ".claude" / "settings.json").read_text())
    assert "Bash(gh workflow run rollback.yml *)" in settings["permissions"]["allow"]


def test_rollback_is_started_by_hand_with_a_choice_and_a_sha(
    rollback_workflow: dict[Any, Any],
) -> None:
    """workflow_dispatch only, and no free-text input: a value the agent types could
    otherwise contain words a deny rule matches, such as deploy-prod (#136 review)."""
    triggers: dict[str, Any] = rollback_workflow.get("on", rollback_workflow.get(True)) or {}
    assert list(triggers) == ["workflow_dispatch"]
    inputs = triggers["workflow_dispatch"]["inputs"]
    assert list(inputs) == ["env", "tag"]
    assert inputs["env"]["type"] == "choice"
    assert inputs["env"]["options"] == ["dev", "prod"]
    assert inputs["env"]["required"] is True
    assert inputs["env"]["default"] == "dev"
    assert inputs["tag"]["type"] == "string"
    assert inputs["tag"]["required"] is False
    assert inputs["tag"]["default"] == ""
    assert "deploy-prod" not in yaml.safe_dump(inputs)


def test_rollback_permissions_are_minimal(
    rollback_workflow: dict[Any, Any], rollback_job: dict[str, Any]
) -> None:
    assert rollback_workflow["permissions"] == {}
    assert list(rollback_workflow["jobs"]) == ["rollback"]
    assert rollback_job["permissions"] == {"contents": "read"}


def test_rollback_runs_in_the_environment_holding_that_key(rollback_job: dict[str, Any]) -> None:
    """prod → `rollback` (the prod rollback key, no reviewer), anything else → `dev` (the dev
    key), never `production`. No GitHub deployment: deploy-prod's plan reads dev's."""
    assert rollback_job["environment"] == {"name": ROLLBACK_ENVIRONMENT, "deployment": False}
    assert "production" not in yaml.safe_dump(rollback_job)
    env = rollback_job["env"]
    assert env["URL"] == (
        "${{ inputs.env == 'prod' && 'https://ineedtofoc.us' || 'https://dev.ineedtofoc.us' }}"
    )
    assert env["TARGET_ENV"] == "${{ inputs.env }}"
    assert env["TAG"] == "${{ inputs.tag }}"


def test_rollback_has_its_own_group_and_never_cancels(
    rollback_workflow: dict[Any, Any],
    rollback_job: dict[str, Any],
    jobs: dict[str, Any],
    prod_jobs: dict[str, Any],
) -> None:
    assert "concurrency" not in rollback_workflow
    assert rollback_job["concurrency"] == {
        "group": "rollback-${{ inputs.env }}",
        "cancel-in-progress": False,
    }
    others = {
        jobs["deploy-dev"]["concurrency"]["group"],
        prod_jobs["deploy"]["concurrency"]["group"],
    }
    assert others == {"deploy-dev", "deploy-prod"}


def test_rollback_reads_the_key_only_to_check_and_set_it_up(rollback_job: dict[str, Any]) -> None:
    readers = {
        step["name"]: set(re.findall(r"secrets\.([A-Za-z_]+)", yaml.safe_dump(step)))
        for step in rollback_job["steps"]
        if "secrets." in yaml.safe_dump(step)
    }
    assert readers == {
        "Check the environment is set up": {"DEPLOY_SSH_KEY", "DEPLOY_KNOWN_HOSTS"},
        "Set up the key": {"DEPLOY_SSH_KEY", "DEPLOY_KNOWN_HOSTS"},
    }
    names = [str(step.get("name", step.get("uses"))) for step in rollback_job["steps"]]
    assert names.index("Check the request") < names.index("Check the environment is set up")


@pytest.mark.parametrize(
    ("overrides", "status", "says"),
    [
        ({}, 0, ""),
        ({"TARGET_ENV": "prod", "TAG": SHA}, 0, ""),
        ({"GITHUB_REF": "refs/heads/topic"}, 1, "title=Not main"),
        ({"TARGET_ENV": "staging"}, 1, "title=Bad env"),
        ({"TARGET_ENV": "prod;id"}, 1, "title=Bad env"),
        ({"TAG": SHA[:12]}, 1, "title=Bad tag"),
        ({"TAG": SHA.upper()}, 1, "title=Bad tag"),
        ({"TAG": f"{SHA};id"}, 1, "title=Bad tag"),
        ({"TAG": f"{SHA}\nid"}, 1, "title=Bad tag"),
        ({"TAG": "deploy-prod"}, 1, "title=Bad tag"),
    ],
)
def test_rollback_checks_the_request_before_any_secret(
    rollback_job: dict[str, Any],
    tmp_path: Path,
    overrides: dict[str, str],
    status: int,
    says: str,
) -> None:
    step = step_named(rollback_job, "Check the request")
    env = {"GITHUB_REF": "refs/heads/main", "TARGET_ENV": "dev", "TAG": "", **overrides}
    result, _, _ = run_step(step, tmp_path, env, "", "unused")
    assert result.returncode == status, result
    assert says in result.stdout


@pytest.mark.parametrize(
    ("target", "key", "known_hosts", "status", "says"),
    [
        ("dev", "KEY", "HOSTS", 0, ""),
        ("prod", "KEY", "HOSTS", 0, ""),
        ("dev", "", "", 1, "the dev environment has no DEPLOY_SSH_KEY and DEPLOY_KNOWN_HOSTS"),
        (
            "prod",
            "",
            "",
            1,
            "the rollback environment has no DEPLOY_SSH_KEY and DEPLOY_KNOWN_HOSTS",
        ),
        ("prod", "KEY", "", 1, "the rollback environment has no DEPLOY_KNOWN_HOSTS."),
        ("dev", "", "HOSTS", 1, "the dev environment has no DEPLOY_SSH_KEY."),
    ],
)
def test_rollback_never_skips_green(
    rollback_job: dict[str, Any],
    tmp_path: Path,
    target: str,
    key: str,
    known_hosts: str,
    status: int,
    says: str,
) -> None:
    """Unlike a deploy, a rollback that can't run fails red: on-call must not read a green
    run as "rolled back"."""
    step = step_named(rollback_job, "Check the environment is set up")
    env = {"TARGET_ENV": target, "DEPLOY_SSH_KEY": key, "DEPLOY_KNOWN_HOSTS": known_hosts}
    result, _, summary = run_step(step, tmp_path, env, "", "unused")
    assert result.returncode == status, result
    assert says in result.stdout
    if status:
        assert "::error title=Not rolled back::" in result.stdout
        assert "Nothing changed" in summary.read_text()


def test_rollback_sends_requests_the_profiles_accept(rollback_job: dict[str, Any]) -> None:
    text = steps_text(rollback_job)
    assert "request=rollback\n" in text and '[[ -n $TAG ]] && request="rollback $TAG"' in text
    assert 'focus "$request expect $EXPECT"' in text
    assert "focus status" in text and "focus candidate" in text
    assert "StrictHostKeyChecking yes" in text and "BatchMode yes" in text
    script = FOCUS_CI.read_text()
    rollback_re = re.search(r"readonly ROLLBACK_RE='(.+)'", script)
    assert rollback_re
    pattern = rollback_re.group(1).strip("^$")
    for ok in ["rollback", f"rollback {SHA}", f"rollback expect {DIGEST}"]:
        assert re.fullmatch(pattern, ok), ok
    assert re.fullmatch(pattern, f"rollback {SHA} expect {DIGEST}")
    for bad in [
        f"rollback {SHA} {DIGEST}",
        f"rollback expect {SHA}",
        f"rollback expect {DIGEST} {SHA}",
    ]:
        assert not re.fullmatch(pattern, bad), bad
    assert len(f"rollback {SHA} expect {DIGEST}") <= 160  # MAX_REQUEST_LENGTH
    profiles = dict(
        re.findall(r"\n  ([a-z-]+)\)\n    env_name=\w+\n    allowed=\(([^)]*)\)", script)
    )
    assert profiles == {
        "dev": "deploy rollback status",
        "prod": "deploy status candidate",
        "rollback-prod": "rollback status",
    }


RESULT = f"result from_tag={SHA} from_digest={DIGEST} tag={THIRD_SHA} digest=sha256:{'e' * 64}"


@pytest.mark.parametrize(
    ("tag", "answer", "sent", "outputs"),
    [
        (
            "",
            f"==> rolling back\n{RESULT}\n",
            f"rollback expect {DIGEST}",
            f"from_tag={SHA}\nfrom_digest={DIGEST}\ntag={THIRD_SHA}\ndigest=sha256:{'e' * 64}\n",
        ),
        (SHA, "no result line\n", f"rollback {SHA} expect {DIGEST}", ""),
    ],
)
def test_rollback_step_sends_the_guarded_request_and_reads_the_result(
    rollback_job: dict[str, Any], tmp_path: Path, tag: str, answer: str, sent: str, outputs: str
) -> None:
    """The request carries the digest read just before (`expect`), and From/To come from
    the server's own result line, written under its lock."""
    step = step_named(rollback_job, "Roll back over SSH")
    env = {
        "TAG": tag,
        "EXPECT": DIGEST,
        "SSH_CONFIG": "/dev/null",
        "SSH_LOG": str(tmp_path / "ssh.log"),
        "RUNNER_TEMP": str(tmp_path),
        "ANSWER": answer,
    }
    result, output, _ = run_step(step, tmp_path, env, FAKE_SSH, "ssh")
    assert result.returncode == 0, result
    assert (tmp_path / "ssh.log").read_text() == f"{sent}\n"
    assert output.read_text() == outputs


def record(env: str = "dev", tag: str = SHA, digest: str = DIGEST, action: str = "deploy") -> str:
    return (
        f"env={env}\ntag={tag}\ndigest={digest}\naction={action}\ndeployed_at=T\n"
        f"previous_tag={THIRD_SHA}\ninfra_revision={OTHER_SHA}\n"
    )


OTHER_DIGEST = "sha256:" + "e" * 64

FAKE_SSH_BY_REQUEST = r"""#!/usr/bin/env bash
# Fake ssh: `status` prints $ANSWER, `candidate` exits $CANDIDATE_RC.
request=${*: -1}
echo "$request" >> "$SSH_LOG"
case $request in
  status) printf '%b' "$ANSWER" ;;
  candidate) exit "$CANDIDATE_RC" ;;
  *) exit 99 ;;
esac
"""


@pytest.mark.parametrize(
    ("target", "answer", "candidate_rc", "status", "sent", "says"),
    [
        ("dev", record(), 0, 0, "status\n", ""),
        ("prod", record(env="prod"), 2, 0, "status\ncandidate\n", ""),
        (
            "dev",
            record(env="prod"),
            0,
            1,
            "status\n",
            "title=Wrong key::the key answers for 'prod'",
        ),
        ("prod", record(), 2, 1, "status\n", "title=Wrong key::the key answers for 'dev'"),
        # The prod deploy key in `rollback`: it answers for prod but runs candidate.
        ("prod", record(env="prod"), 0, 1, "status\ncandidate\n", "isn't the prod rollback key"),
        ("prod", record(env="prod"), 1, 1, "status\ncandidate\n", "got exit 1"),
        ("prod", record(env="prod"), 255, 1, "status\ncandidate\n", "got exit 255"),
        ("dev", "", 0, 1, "status\n", "title=Nothing to roll back"),
        ("dev", record(digest="sha256:short"), 0, 1, "status\n", "release record is malformed"),
    ],
)
def test_rollback_checks_the_key_belongs_there_first(
    rollback_job: dict[str, Any],
    tmp_path: Path,
    target: str,
    answer: str,
    candidate_rc: int,
    status: int,
    sent: str,
    says: str,
) -> None:
    """A key in the wrong environment stops before the rollback: the record must name the
    environment, and for prod only the rollback profile refuses `candidate` (exit 2)."""
    step = step_named(rollback_job, "Read what runs now")
    env = {
        "TARGET_ENV": target,
        "SSH_CONFIG": "/dev/null",
        "SSH_LOG": str(tmp_path / "ssh.log"),
        "RUNNER_TEMP": str(tmp_path),
        "ANSWER": answer,
        "CANDIDATE_RC": str(candidate_rc),
    }
    result, output, _ = run_step(step, tmp_path, env, FAKE_SSH_BY_REQUEST, "ssh")
    assert result.returncode == status, result
    assert (tmp_path / "ssh.log").read_text() == sent
    assert says in result.stdout
    if status == 0:
        assert output.read_text() == f"tag={SHA}\ndigest={DIGEST}\n"


@pytest.mark.parametrize(
    ("answer", "tag", "to_digest", "status", "says"),
    [
        (record(tag=OTHER_SHA, digest=OTHER_DIGEST, action="rollback"), "", OTHER_DIGEST, 0, ""),
        (
            record(tag=OTHER_SHA, digest=OTHER_DIGEST, action="rollback"),
            OTHER_SHA,
            OTHER_DIGEST,
            0,
            "",
        ),
        (
            record(tag=OTHER_SHA, digest=OTHER_DIGEST, action="deploy"),
            "",
            OTHER_DIGEST,
            1,
            "doesn't show a rollback",
        ),
        (
            record(env="prod", tag=OTHER_SHA, digest=OTHER_DIGEST, action="rollback"),
            "",
            OTHER_DIGEST,
            1,
            "doesn't show a rollback",
        ),
        (record(action="rollback"), "", DIGEST, 1, "rolled back from"),
        (
            record(tag=OTHER_SHA, digest=OTHER_DIGEST, action="rollback"),
            "",
            "sha256:" + "f" * 64,
            1,
            "not sha256:fff",
        ),
        (
            record(tag=OTHER_SHA, digest=OTHER_DIGEST, action="rollback"),
            THIRD_SHA,
            OTHER_DIGEST,
            1,
            f"not {THIRD_SHA}",
        ),
        (
            record(tag=OTHER_SHA, digest=OTHER_DIGEST, action="rollback"),
            "",
            "",
            1,
            "printed no result line",
        ),
    ],
)
def test_rollback_reads_the_record_back(
    rollback_job: dict[str, Any],
    tmp_path: Path,
    answer: str,
    tag: str,
    to_digest: str,
    status: int,
    says: str,
) -> None:
    """The record must show the rollback the server reported: that environment, action
    rollback, the result's digest (not the one left), and the tag when one was asked for."""
    step = step_named(rollback_job, "Read the server's release record")
    env = {
        "TARGET_ENV": "dev",
        "TAG": tag,
        "FROM_TAG": SHA,
        "FROM_DIGEST": DIGEST,
        "TO_DIGEST": to_digest,
        "SSH_CONFIG": "/dev/null",
        "SSH_LOG": str(tmp_path / "ssh.log"),
        "RUNNER_TEMP": str(tmp_path),
        "ANSWER": answer,
    }
    result, output, _ = run_step(step, tmp_path, env, FAKE_SSH, "ssh")
    assert result.returncode == status, result
    assert says in result.stdout
    if status == 0:
        assert f"tag={OTHER_SHA}\ndigest={OTHER_DIGEST}\n" in output.read_text()


def test_rollback_summary_takes_from_and_to_from_the_server(rollback_job: dict[str, Any]) -> None:
    env = step_named(rollback_job, "Summary")["env"]
    assert env["FROM_TAG"] == "${{ steps.rollback.outputs.from_tag || steps.before.outputs.tag }}"
    assert env["FROM_DIGEST"] == (
        "${{ steps.rollback.outputs.from_digest || steps.before.outputs.digest }}"
    )
    assert env["TO_TAG"] == "${{ steps.rollback.outputs.tag }}"
    assert env["TO_DIGEST"] == "${{ steps.rollback.outputs.digest }}"


def test_rollback_deletes_the_key_before_running_repo_code(rollback_job: dict[str, Any]) -> None:
    steps = rollback_job["steps"]
    names = [str(step.get("name", step.get("uses"))) for step in steps]
    early = step_named(rollback_job, "Remove the key before")
    assert early["run"] == 'rm -rf "$RUNNER_TEMP/deploy-ssh"'
    assert early["if"] == "always()"
    position = names.index(early["name"])
    ssh_steps = [i for i, step in enumerate(steps) if "ssh " in str(step.get("run", ""))]
    assert ssh_steps and max(ssh_steps) < position
    assert position < names.index(step_named(rollback_job, "Smoke-test")["name"])
    assert steps[-1]["if"] == "always()"
    assert steps[-1]["run"] == 'rm -rf "$RUNNER_TEMP/deploy-ssh"'


def test_rollback_smoke_tests_the_environment(rollback_job: dict[str, Any]) -> None:
    smoke = step_named(rollback_job, "Smoke-test")
    assert smoke["run"].startswith('python3 scripts/smoke_deploy.py "$URL"')
    names = [step.get("name", step.get("uses")) for step in rollback_job["steps"]]
    assert names.index(smoke["name"]) > names.index(
        step_named(rollback_job, "Roll back over SSH")["name"]
    )


# --- Pipelines run with pipefail (#157 review round 2) --------------------------------


def has_pipeline(script: str) -> bool:
    """A `|` that pipes, outside quotes, comments, `||` and case patterns' `a | b)`."""
    for line in script.splitlines():
        code = re.sub(r"\"(?:[^\"\\]|\\.)*\"|'[^']*'", "", line).split(" #")[0]
        if code.lstrip().startswith("#"):
            continue
        code = code.replace("||", "")
        if re.search(r"^\s*[\w*=-]+(\s*\|\s*[\w*=-]+)+\)", code):  # a case pattern
            continue
        if "|" in code:
            return True
    return False


def test_has_pipeline_reads_scripts_right() -> None:
    assert has_pipeline('ssh x "a" | tee f')
    assert has_pipeline("docker save x | gzip > y")
    assert not has_pipeline("a || b")
    assert not has_pipeline('echo "| a | b |"')
    assert not has_pipeline("  from_tag=* | tag=*) echo x ;;")
    assert not has_pipeline("# a | b")


@pytest.mark.parametrize("path", all_workflows(), ids=lambda p: p.name)
def test_every_step_with_a_pipeline_runs_with_pipefail(path: Path) -> None:
    """GitHub runs a step with no shell as `bash -e {0}`: a pipeline then takes its last
    command's status, so `ssh … | tee` hides a failed request. Such steps need `shell: bash`
    (`-eo pipefail`), on the step or as a default."""
    for job_name, job in load_workflow(path)["jobs"].items():
        for step in job.get("steps", []):
            if "run" in step and has_pipeline(step["run"]):
                assert step["_shell"] == "bash", (path.name, job_name, step.get("name"))


def test_rollback_and_deploy_prod_default_to_bash(
    rollback_workflow: dict[Any, Any], prod_workflow: dict[Any, Any]
) -> None:
    assert rollback_workflow["defaults"] == {"run": {"shell": "bash"}}
    assert prod_workflow["defaults"] == {"run": {"shell": "bash"}}


FAKE_SSH_EXITS = r"""#!/usr/bin/env bash
# Fake ssh for the rollback step: prints $ANSWER, exits $SSH_RC.
echo "${*: -1}" >> "$SSH_LOG"
printf '%b' "$ANSWER"
exit "$SSH_RC"
"""


@pytest.mark.parametrize(
    ("rc", "answer"),
    [
        (1, "focus-ci: FAILED: dev runs a now, not the expected b\n"),
        (1, f"{RESULT}\n"),  # even a result line can't turn a failed request green
        (2, "focus-ci: refused: not a request this key can make\n"),
        (255, ""),
    ],
)
def test_rollback_step_fails_when_the_server_does(
    rollback_job: dict[str, Any], tmp_path: Path, rc: int, answer: str
) -> None:
    """A failed or refused server rollback turns the step red (pipefail), so the summary
    reports a failure, not "rolled back"."""
    step = step_named(rollback_job, "Roll back over SSH")
    env = {
        "TAG": "",
        "EXPECT": DIGEST,
        "SSH_CONFIG": "/dev/null",
        "SSH_LOG": str(tmp_path / "ssh.log"),
        "RUNNER_TEMP": str(tmp_path),
        "ANSWER": answer,
        "SSH_RC": str(rc),
    }
    result, output, _ = run_step(step, tmp_path, env, FAKE_SSH_EXITS, "ssh")
    assert result.returncode == rc, result
    assert output.read_text() == ""


@pytest.mark.parametrize(
    ("target", "outcome", "says", "never"),
    [
        ("dev", "failure", "The rollback failed", "marked as rolled back from"),
        ("prod", "failure", "The rollback failed", "marked as rolled back from"),
        ("dev", "success", "is marked as rolled back from on dev", "The rollback failed"),
        ("prod", "success", "rolled back, smoke tests", "marked as rolled back from"),
    ],
)
def test_rollback_summary_reports_a_failed_rollback_as_failed(
    rollback_job: dict[str, Any], tmp_path: Path, target: str, outcome: str, says: str, never: str
) -> None:
    step = step_named(rollback_job, "Summary")
    env = {
        "TARGET_ENV": target,
        "TAG": "",
        "URL": "https://dev.ineedtofoc.us",
        "RUNNER_TEMP": str(tmp_path),
        "FROM_TAG": SHA,
        "FROM_DIGEST": DIGEST,
        "TO_TAG": THIRD_SHA if outcome == "success" else "",
        "TO_DIGEST": OTHER_DIGEST if outcome == "success" else "",
        "ROLLBACK_OUTCOME": outcome,
        "SMOKE_OUTCOME": "success" if outcome == "success" else "skipped",
    }
    result, _, summary = run_step(step, tmp_path, env, "", "unused")
    assert result.returncode == 0, result
    text = summary.read_text()
    assert f"### Roll back {target}: {'rolled back' if outcome == 'success' else 'failure'}" in text
    assert says in text and never not in text
