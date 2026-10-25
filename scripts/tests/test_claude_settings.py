""".claude/settings.json read as data: the prod-deploy deny rules (#126) and the concurrent
agent cap in its `env` block (#172, at the end of this file).

Agents run `gh` as merciful-poseidon (#127), which can't approve a prod deploy: it isn't a
`production` reviewer or an administrator. These rules are the second line, keeping agents
from starting or trying to approve a prod deploy by mistake. The rollback workflow
(#30) must stay runnable without a prompt, so no deny or ask rule may match it: in Claude
Code deny beats ask, and ask beats allow. Nothing here runs a command; each sample is only
matched against the rule patterns.
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

# The one-time check that the `dev` environment's branch rule still holds with
# `deployment: false` (_docs/deployment.md, Rollback, one-time setup): `--ref` after the
# file name is fine for the allow rule.
BRANCH_RULE_CHECK = "gh workflow run rollback.yml --ref check/rollback-branch-rule -f env=dev"

# What the on-call agent and the lead run to roll back (rollback.yml, #30). Tags are commit
# shas, so they may start with a digit.
ROLLBACK_COMMANDS = [
    "gh workflow run rollback.yml -f env=prod",
    f"gh workflow run rollback.yml -f env=prod -f tag={SHA}",
    f"gh workflow run rollback.yml --ref main -f env=prod -f tag={SHA}",
    "gh workflow run rollback.yml -f env=dev",
    "gh workflow run rollback.yml -f env=prod --repo ybenzine/ineedtofocus",
    BRANCH_RULE_CHECK,
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


# --- The on-call agent's rollback commands (#30, #136 review) ----------------------------

ONCALL = REPO / ".claude" / "agents" / "oncall.md"
RUNBOOK = REPO / "_docs" / "runbooks" / "rollback.md"

# The exact commands .claude/agents/oncall.md and _docs/runbooks/rollback.md give.
ONCALL_COMMANDS = [
    "gh workflow run rollback.yml -f env=prod",
    "gh workflow run rollback.yml -f env=dev",
    f"gh workflow run rollback.yml -f env=prod -f tag={SHA}",
    "gh run list --workflow rollback.yml --limit 1"
    " --json databaseId,createdAt,status,conclusion,url",
    "gh run watch 18234567890 --exit-status",
    "gh run list --workflow deploy-prod.yml --limit 5",
    "gh run list --workflow ci.yml --branch main --event push --limit 5",
]


def documented_commands(path: Path) -> list[str]:
    """The `gh` commands in a doc's fenced code blocks, comments stripped and the <sha> and
    <databaseId> placeholders filled in."""
    commands = []
    in_block = False
    for raw in path.read_text().splitlines():
        line = raw.strip()
        if line.startswith("```"):
            in_block = not in_block
            continue
        if in_block and line.startswith("gh "):
            command = line.split("  #")[0].strip()
            command = command.replace("<sha>", SHA).replace("<databaseId>", "18234567890")
            commands.append(command)
    return commands


@pytest.mark.parametrize("path", [ONCALL, RUNBOOK], ids=lambda p: p.name)
def test_docs_give_only_commands_that_run_without_a_prompt(path: Path) -> None:
    """What on-call copies from its prompt and the runbook must be allowed, and no deny or
    ask rule may match it, or an unattended run stalls."""
    commands = documented_commands(path)
    assert any(c.startswith("gh workflow run rollback.yml ") for c in commands), path
    for command in commands:
        assert command in ONCALL_COMMANDS or command.startswith("gh run "), command
        assert matching("allow", command), command
        assert matching("deny", command) == [], command
        assert matching("ask", command) == [], command


def test_oncall_prompt_has_the_exact_rollback_command() -> None:
    text = ONCALL.read_text()
    assert "gh workflow run rollback.yml -f env=prod\n" in text
    assert "`-f env=dev`" in text


@pytest.mark.parametrize("path", [ONCALL, RUNBOOK], ids=lambda p: p.name)
def test_rollback_yml_comes_straight_after_gh_workflow_run(path: Path) -> None:
    """Every `gh workflow run` in these docs, templates included, is followed by rollback.yml:
    a flag in between matches no allow rule (#136 review, point 2)."""
    text = path.read_text()
    uses = re.findall(r"gh workflow run(\s+\S+)", text)
    assert uses
    assert {use.strip() for use in uses} == {"rollback.yml"}, uses


@pytest.mark.parametrize("command", ONCALL_COMMANDS)
def test_oncall_commands_run_without_a_prompt(command: str) -> None:
    assert matching("allow", command), command
    assert matching("deny", command) == [], command
    assert matching("ask", command) == [], command


def test_a_flag_before_rollback_yml_isnt_allowed() -> None:
    """Why the docs insist on the order: this form matches no allow rule, so it prompts."""
    command = "gh workflow run --ref main rollback.yml -f env=prod"
    assert matching("allow", command) == []


def test_free_text_mentioning_deploy_prod_would_be_denied() -> None:
    """Why rollback.yml has no free-text input: a value with deploy-prod in it hits #126's
    deny rule. tests/test_ci_workflow.py checks the inputs are a choice and a sha."""
    command = 'gh workflow run rollback.yml -f env=prod -f reason="deploy-prod broke saves"'
    assert "Bash(gh workflow run *deploy-prod*)" in matching("deny", command)


def test_the_branch_rule_check_is_documented_as_run() -> None:
    """The setup doc gives exactly the command checked above, with `--ref` after the file."""
    deployment = (REPO / "_docs" / "deployment.md").read_text()
    assert f"`{BRANCH_RULE_CHECK}`" in deployment
    assert matching("allow", BRANCH_RULE_CHECK) and not matching("ask", BRANCH_RULE_CHECK)


# --- At most 4 agents at once per session (#172) ------------------------------------------

ENV: dict[str, str] = json.loads(SETTINGS.read_text()).get("env", {})


@pytest.mark.parametrize(
    "variable",
    ["CLAUDE_CODE_MAX_CONCURRENT_SUBAGENTS", "CLAUDE_CODE_WORKFLOW_MAX_CONCURRENT_AGENTS"],
)
def test_concurrent_agents_are_capped_at_four(variable: str) -> None:
    """Eight or more parallel agents kept tripping GitHub's secondary rate limit (#172).
    Claude Code ignores a subagent cap that isn't a positive whole number in plain digits,
    so the value is exactly the string "4"."""
    assert ENV.get(variable) == "4", variable
