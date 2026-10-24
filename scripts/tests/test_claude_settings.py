"""The prod-deploy deny rules in .claude/settings.json (#126), read as data.

Agents run `gh` as Yacine, the `production` environment's required reviewer, so these
rules keep them from starting or approving a prod deploy by mistake. The rollback workflow
(#30) must stay runnable without a prompt, so no deny or ask rule may match it: in Claude
Code deny beats ask, and ask beats allow. Nothing here runs a command; each sample is only
matched against the rule patterns. The real fix is the agent credential in #127.
"""

from __future__ import annotations

import json
import re
from pathlib import Path

import pytest

REPO = Path(__file__).resolve().parents[2]
SETTINGS = REPO / ".claude" / "settings.json"
PERMISSIONS: dict[str, list[str]] = json.loads(SETTINGS.read_text())["permissions"]

ROLLBACK_ALLOW = "Bash(gh workflow run rollback.yml *)"
NUMERIC_ID_DENIES = [f"Bash(gh workflow run {digit}*)" for digit in "0123456789"]
APPROVAL_DENIES = ["Bash(gh api *pending_deployments*)", "Bash(gh api *approveDeployments*)"]
START_DENIES = ["Bash(gh workflow run deploy-prod*)", "Bash(gh workflow run *deploy-prod*)"]

SHA = "0123456789abcdef0123456789abcdef01234567"
RUN = "repos/ybenzine/ineedtofocus/actions/runs/18234567890"

# What the on-call agent and the lead run to roll back (rollback.yml, #30). Tags are commit
# shas, so they may start with a digit.
ROLLBACK_COMMANDS = [
    "gh workflow run rollback.yml -f env=prod",
    f"gh workflow run rollback.yml -f env=prod -f tag={SHA}",
    f"gh workflow run rollback.yml --ref main -f env=prod -f tag={SHA}",
    "gh workflow run rollback.yml -f env=dev",
    "gh workflow run rollback.yml -f env=prod --repo ybenzine/ineedtofocus",
]

# Ordinary CI work the new rules must not block.
ROUTINE_COMMANDS = [
    "gh run rerun 18234567890 --failed",
    "gh run rerun 18234567890",
    "gh run view 18234567890 --log-failed",
    "gh run list --workflow ci.yml",
    "gh workflow view deploy-prod",
    f"gh api {RUN}",
    f"gh api {RUN}/jobs",
]

# Starting or approving a prod deploy: each must hit a deny rule.
PROD_DEPLOY_COMMANDS = [
    "gh workflow run deploy-prod",
    "gh workflow run deploy-prod.yml",
    f"gh workflow run deploy-prod.yml -f tag={SHA}",
    "gh workflow run --ref main deploy-prod.yml",
    'gh workflow run "deploy-prod"',
    "gh workflow run .github/workflows/deploy-prod.yml",
    "gh workflow run 201234567",
    "gh workflow run 0",
    f"gh workflow run 987654321 -f tag={SHA}",
    f"gh api -X POST {RUN}/pending_deployments -f state=approved -F environment_ids[]=1",
    f"gh api --method POST {RUN}/pending_deployments --input /tmp/approve.json",
    f"gh api {RUN}/pending_deployments",
    "gh api graphql -f query='mutation { approveDeployments(input: {}) { clientMutationId } }'",
]


def pattern_matches(rule: str, command: str) -> bool:
    """Whether a `Bash(...)` rule matches a command, the way Claude Code reads it: `*`
    matches any run of characters, spaces included, and a trailing ` *` also matches the
    bare command (`Bash(ls *)` matches `ls`). Other rule kinds never match a command."""
    if not (rule.startswith("Bash(") and rule.endswith(")")):
        return False
    pattern = rule[len("Bash(") : -1]
    regex = ".*".join(re.escape(part) for part in pattern.split("*"))
    if re.fullmatch(regex, command, re.DOTALL):
        return True
    return pattern.endswith(" *") and command == pattern[:-2]


def matching(kind: str, command: str) -> list[str]:
    return [rule for rule in PERMISSIONS[kind] if pattern_matches(rule, command)]


def test_matcher_reads_rules_like_claude_code() -> None:
    assert pattern_matches("Bash(gh workflow run 1*)", "gh workflow run 12")
    assert pattern_matches("Bash(gh api *x*)", "gh api a x b")
    assert pattern_matches("Bash(ls *)", "ls")
    assert not pattern_matches("Bash(gh workflow run 1*)", "gh workflow run rollback.yml 1")
    assert not pattern_matches("Read(.env)", ".env")


@pytest.mark.parametrize("rule", START_DENIES + NUMERIC_ID_DENIES + APPROVAL_DENIES)
def test_prod_deploy_deny_rule_is_present(rule: str) -> None:
    assert rule in PERMISSIONS["deny"]


def test_rollback_stays_allowed() -> None:
    assert ROLLBACK_ALLOW in PERMISSIONS["allow"]


@pytest.mark.parametrize("command", ROLLBACK_COMMANDS)
def test_rollback_is_not_shadowed(command: str) -> None:
    """Deny beats allow and ask stalls an unattended on-call run, so neither may match."""
    assert pattern_matches(ROLLBACK_ALLOW, command)
    assert matching("deny", command) == []
    assert matching("ask", command) == []


@pytest.mark.parametrize("command", ROUTINE_COMMANDS)
def test_routine_ci_commands_are_not_denied(command: str) -> None:
    """Re-runs stay open on purpose: a run ID doesn't say which workflow it belongs to, and
    a re-run of deploy-prod still waits for an approval that the rules above deny."""
    assert matching("deny", command) == []


@pytest.mark.parametrize("command", PROD_DEPLOY_COMMANDS)
def test_prod_deploy_commands_are_denied(command: str) -> None:
    assert matching("deny", command), command
