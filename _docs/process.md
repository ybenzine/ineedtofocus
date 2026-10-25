# Process

How work moves from an issue to production. Every agent follows this; the reviewer agent enforces it.

The team works through the backlog on its own (`/work-backlog`). Yacine is pulled in only at the [human gates](#human-gates).

## Sources of truth

| Question | Source |
|---|---|
| What should the product do? | [product_decisions.md](product_decisions.md) — features `F1`–`F13`, acceptance criteria `ACx.y` |
| What technology and how is it run? | [tech_stack.md](tech_stack.md) |
| What is being worked on, by whom, and its status? | GitHub Issues + the [project board](https://github.com/users/ybenzine/projects/2) |
| Who does what? | [agents.md](agents.md) |

`backlog/backlog.yaml` seeded the board on 2026-10-20. From then on **the GitHub issues are the live backlog**; new work is created as new issues.

## Board

Columns (the project's Status field): **Todo → In progress → In review → Done**.

| Status | Meaning | Moved by |
|---|---|---|
| Todo | Ready to pick up | Board workflow when the issue is added |
| In progress | An agent is working on it | Agent at start (`scripts/board-status.sh <n> "In progress"`) |
| In review | PR open, waiting for the reviewer agent | Agent when the PR is opened |
| Done | PR merged, issue closed | Board workflow on close/merge |

After Done, final acceptance — by the product manager, or by QA for issues the product manager owns — adds the **`accepted`** label (or reopens the issue). An issue is finished only when it is Done **and** `accepted`.

Milestones (`M1`–`M5`) are the schedule; work the current milestone first, `P0` before `P1`. `post-mvp` issues are not touched before submission.

## Posting to the tracker

Write every issue comment, PR body and review body to a file under `/tmp` (outside the repo) first, then post it from that file:

- `gh issue comment <n> --body-file <file>`
- `gh pr create --body-file <file>` and `gh pr edit <pr> --body-file <file>`
- `scripts/reviewer-review.sh <pr> approve|request-changes <file>` (the reviewer agent: `gh pr review --body-file` as the reviewer App, see [§4](#4-review))
- `gh issue create --body-file <file>` and `gh issue edit <n> --body-file <file>`
- REST fallback: `gh api -X POST <path> -F body=@<file>`

Never pass a body inline (`--body "…"`, `-b "…"`, `-f body=…`). The permission rules in `.claude/settings.json` match the whole command text, so a word such as "protection", "environments", "dispatches" or "private=" in an inline body triggers an ask or deny rule and stalls an unattended run.

## Lifecycle of an issue

### 1. Pick up
- Take an open issue with **your** `agent:*` label in the current milestone, status Todo, whose dependencies are done.
- Post the start comment and move the card to **In progress**:

  > 🟡 **\<agent\> agent — started**
  > Branch `<agent>/<n>-<slug>`. Plan: \<2–4 bullets mapping to the ACs\>.

- If you're blocked (missing dependency, unclear AC, needs a human), comment `⛔ Blocked by #<n>` or `⛔ Needs Yacine: <exact ask>` and leave the card in Todo.

### 2. Build
- Branch from up-to-date `main`: `<agent>/<n>-<slug>`.
- Implement **exactly** the acceptance criteria. Scope questions go to the product manager agent (comment on the issue), not into the code.
- Write the tests with the change (see [testing.md](testing.md)). Run `make lint` and `make test` before pushing.
- Small Conventional Commits that reference the issue (`feat(sessions): idempotent save — Refs #10`).

### 3. Open the PR
- Title: Conventional Commit style. Body from the PR template: `Closes #<n>`, each AC with how it's met, test evidence.
- Comment on the issue with the PR link and move the card to **In review**:

  > 🔵 **\<agent\> agent — PR open:** #\<pr\>. All ACs addressed; `make test` green (or N/A: docs only).

### 4. Review
- The **reviewer agent** reads the issue and the PR and posts a review with one line per AC: ✅ met / ❌ not met (why) / ➖ not applicable (why), plus the definition-of-done checks and numbered findings.
- The review ends with `**Verdict: Approve**` or `**Verdict: Request changes**`, the human-readable signal.
- The reviewer posts it as a **real GitHub review from the reviewer App's bot** (`scripts/reviewer-review.sh`, which runs `gh pr review --approve` or `--request-changes` with `--body-file`), and the event matches the verdict. All agents act through one GitHub account, `merciful-poseidon` ([infra/github/README.md](../infra/github/README.md#agent-account-127)), which also authors the PRs and so can't approve them; the App is a separate bot identity that can ([infra/github/README.md](../infra/github/README.md#reviewer-github-app-70)). Its approval is what lets the PR merge: `gh pr view <pr> --json reviewDecision` shows `APPROVED`.
- **Fallback:** if the App's private key is unavailable, the script posts the same body as a comment review from the agent account. A comment can't approve, so the merge waits for Yacine to restore the key (a `⛔ Needs Yacine:` on the issue); the reviewer then posts its review again through the App.
- On Request changes, the author fixes each numbered point and the reviewer reviews again, for at most three rounds, then one retry on Fable 5.1; after that it's a [human gate](#human-gates) (repeated failure).
- CI must be green. Branch protection on `main` (#5, #70) requires the five CI checks **and one approving review**, for administrators too. A push after the approval dismisses it, so the reviewer reviews the final commit.

### 5. Merge
- After `**Verdict: Approve**` (posted as the bot's approving review, `reviewDecision` `APPROVED`) and green CI, the authoring agent **squash-merges**. No human approval is needed to merge: merging deploys to dev only, and prod has its own gate.
- On merge: the issue closes (`Closes #n`), the board moves it to Done, the branch is auto-deleted.
- The author ticks the satisfied checkboxes in the issue body and posts the closing comment:

  > ✅ **\<agent\> agent — done** in #\<pr\>. \<one line on anything notable or follow-ups (#n)\>.

### 6. Verify
- Merge to `main` deploys to **dev** automatically (once #28 lands; until then, verification uses the local stack).
- For `type:feature` issues the QA agent runs the feature's flow and comments `🧪 qa agent — verified on dev` (or `verified locally`), or files a `bug` issue.

### 7. Accept
- The **product manager agent** (or the **QA agent** for issues the product manager owns, so nobody accepts their own work) checks the delivered work against the running app and the issue's ACs, then either adds the `accepted` label with a `🟢 accepted` comment, or reopens the issue (`🔴 not accepted` with numbered gaps) or files a follow-up issue. See [.claude/agents/product-manager.md](../.claude/agents/product-manager.md).

### 8. Release to prod
- Prod is a manual workflow run that **Yacine approves** (a human gate). The lead asks for it when a milestone's user-facing work is accepted on dev. See [deployment.md](deployment.md).

## Human gates

Agents stop and ask Yacine **only** for these: they comment `⛔ Needs Yacine: <exact ask, options, recommendation>` on the issue and add the **`needs-yacine`** label. Yacine answers on the issue and removes the label; that's the signal to resume. Everything else — picking work, deciding within agreed scope, reviewing, merging, accepting — the team does on its own, and it keeps working on other unblocked issues while it waits.

| Gate | Examples |
|---|---|
| **Production deploys** | Approving the prod deploy workflow run. Exception: the on-call agent may roll prod back to the last known-good tag without approval. The gate is enforced by credentials, not trust: agents' own account can't approve it (see below) |
| **`owner:human` tasks** | DigitalOcean, Route 53, Grafana Cloud, GitHub secrets/environments, API keys |
| **Product decisions beyond agreed scope** | Changing or cutting a requirement in `product_decisions.md`, changing the MVP cut order, adding a feature |
| **Cost** | Anything that spends money (bigger Droplet, paid services) |
| **Irreversible actions** | Deleting data, servers or repos; force-pushing; rewriting history; destroying volumes |
| **Repeated failure** | The same PR fails review three rounds in a row and then one more after a Fable 5.1 retry (see [agents.md → Models](agents.md#models)), or CI is still red after three fix attempts — stop and report instead of looping |

**Why agents can merge workflow changes safely:** prod credentials (the prod SSH deploy key and prod secrets) exist **only** as secrets of the GitHub `production` environment, which requires Yacine's approval for every job that uses it. The dev deploy key lives in a `dev` environment and is restricted on the server (SSH forced command) to deploying and rolling back dev. The prod **rollback** key lives in a separate `rollback` environment (no reviewer, so on-call can use it at any hour; limited to the `main` branch) and is restricted by forced command to restoring a recorded known-good tag — it can't deploy anything new. Non-deploy secrets follow the same rule: the Claude API key and the read-only Grafana token used by the on-call workflow (#35, #32) live in an `oncall` environment (no reviewer, `main` branch only), and the Grafana Cloud OTLP token (#32) lives only in the server's per-environment `.env` files, read by the collector. No credential is stored at repo level. A workflow edit merged by an agent therefore can't put new code on prod without Yacine's approval. Set up in #28–#30.

**Why that approval holds against agents (#127):** agents act as the machine account `merciful-poseidon`, never as Yacine. It has write access to the repo and the board, which the whole loop needs (issues, PRs, merges, the board, the `rollback` workflow), but it isn't an administrator and isn't a reviewer of the `production` environment. Only listed reviewers can approve a deployment, and only administrators can edit an environment or its secrets, so no command an agent runs can approve a prod deploy, remove the reviewer or read the prod key. Yacine is the only `production` reviewer, and administrators can't bypass the rule. #126's deny rules in `.claude/settings.json` (starting `deploy-prod`, approving through `pending_deployments` or `approveDeployments`) stay as a second line. Sessions start with `claude-focus` so `gh` and `git push` use that account; setup, checks and the residual risk (Yacine's own login on the same machine) are in [infra/github/README.md](../infra/github/README.md#agent-account-127).

## Definition of done

An issue is done when **all** of these hold:

- [ ] Every acceptance criterion is met and checked off in the issue
- [ ] Tests added or updated; `make test` passes locally and in CI (docs-only changes: N/A, say so)
- [ ] PR says `Closes #<n>` and the reviewer agent's verdict is **Approve**, posted as the reviewer App's approving review
- [ ] Product manager accepted it (`accepted` label; QA accepts the product manager's own issues)
- [ ] Docs updated if behavior, setup or commands changed
- [ ] No secrets or customer data added to code, logs or telemetry

## Changing scope

- Only the **product manager agent** edits `product_decisions.md`.
- **Within agreed scope** (defaults, edge cases, wording, layout details, clarifying an ambiguous AC) the product manager decides, answers on the issue, and records it in the **Decision log** of `product_decisions.md`.
- **Beyond agreed scope** (changing or cutting a requirement, adding a feature, changing the cut order) is a human gate: the product manager asks Yacine with options and a recommendation.
- A requirement change updates, in one PR: `product_decisions.md`, the affected issue(s)' acceptance criteria, and a short note in the PR on why.
- New work found mid-task becomes a **new issue** (labels, milestone, ACs) instead of growing the current PR.

## Incidents

Production alerts wake the **on-call agent** (see [agents.md](agents.md)). It opens a `type:incident` issue, follows the matching runbook in [runbooks/](runbooks/), and either rolls back to the last known-good release or opens a fix PR with a regression test. Fix PRs go through the normal review and merge above (merging deploys the fix to dev); getting the fix to prod is a prod deploy, so Yacine approves it. A rollback to a known-good tag needs no approval.
