"""The deploy rules in .github/workflows/ (#27, #28, #29) that a workflow edit must not
break silently: the five required check names, publish's gate, deploy-dev's gate,
environment, concurrency and use of the forced command, and deploy-prod.yml's manual-only
trigger, `production` environment, secrets and requests (its own tests below)."""

from __future__ import annotations

import json
import re
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


@pytest.fixture(scope="module")
def workflow() -> dict[Any, Any]:
    data: dict[Any, Any] = yaml.safe_load(CI.read_text())
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
    deploy = jobs["deploy-dev"]
    assert deploy["environment"] == {"name": "dev", "url": "https://dev.ineedtofoc.us"}
    assert deploy["concurrency"] == {"group": "deploy-dev", "cancel-in-progress": False}
    assert deploy["permissions"] == {"contents": "read"}


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
    result = subprocess.run(
        ["bash", "-e", "-o", "pipefail", "-c", step["run"]],
        env=env,
        capture_output=True,
        text=True,
        check=False,
    )
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


@pytest.fixture(scope="module")
def prod_workflow() -> dict[Any, Any]:
    data: dict[Any, Any] = yaml.safe_load(DEPLOY_PROD.read_text())
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
    assert prod_jobs["deploy"]["permissions"] == {"contents": "read"}


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
# Fake gh for the plan step: canned answers (after --jq) per API path.
path=$2
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
  repos/o/r/compare/*) [[ $COMPARE == missing ]] && exit 1; echo "$COMPARE" ;;
  repos/o/r/actions/workflows/ci.yml/runs*) echo "$CI_RUNS" ;;
  repos/o/r/commits/*) echo "feat: a | change (#1)" ;;
  *) echo "unexpected gh call: $*" >&2; exit 1 ;;
esac
echo "$*" >> "$GH_LOG"
"""


def run_step(
    step: dict[str, Any], tmp_path: Path, env: dict[str, str], fake: str, name: str
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
    result = subprocess.run(
        ["bash", "-e", "-o", "pipefail", "-c", step["run"]],
        env=full_env,
        capture_output=True,
        text=True,
        check=False,
    )
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
        ({"STATE_12": "failure"}, 1, "", "title=Dev's release unknown"),
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
    which must be a full sha on main with a green CI run on main."""
    step = step_named(prod_jobs["plan"], "Pick the commit")
    env = {
        "GH_REPO": "o/r",
        "GH_TOKEN": "not-a-token",
        "GH_LOG": str(tmp_path / "gh.log"),
        "GITHUB_REF": "refs/heads/main",
        "INPUT_TAG": "",
        "DEV_DEPLOYMENTS": f"12 {OTHER_SHA}\n11 {SHA}\n",
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


# --- rollback.yml (#30) ---------------------------------------------------------------

ROLLBACK = WORKFLOWS / "rollback.yml"
ROLLBACK_ENVIRONMENT = "${{ inputs.env == 'prod' && 'rollback' || 'dev' }}"


@pytest.fixture(scope="module")
def rollback_workflow() -> dict[Any, Any]:
    data: dict[Any, Any] = yaml.safe_load(ROLLBACK.read_text())
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
