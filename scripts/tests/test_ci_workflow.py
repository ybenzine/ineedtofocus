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
  repos/o/r/deployments\?environment=dev*) printf '%b' "$DEV_DEPLOYMENTS" ;;
  repos/o/r/deployments/*/statuses*)
    id=${path#repos/o/r/deployments/}
    id=${id%%/*}
    var=STATE_$id
    echo "${!var:-}"
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
        ("true", OTHER_SHA, 1, "candidate", "title=Dev moved"),
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
