"""The deploy rules in .github/workflows/ci.yml (#27, #28) that a workflow edit must not
break silently: the five required check names, publish's gate, and deploy-dev's gate,
environment, concurrency and use of the forced command."""

from __future__ import annotations

import json
import re
from pathlib import Path
from typing import Any

import pytest
import yaml  # type: ignore[import-untyped]  # no stubs in the locked env

REPO = Path(__file__).resolve().parents[2]
CI = REPO / ".github" / "workflows" / "ci.yml"
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
