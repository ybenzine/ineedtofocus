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

## Parallel sessions: one worktree each

**One git worktree per parallel Claude Code session** (#83). Two sessions never share a folder. A checkout has one current branch and one `.env`, so on 2026-10-23, when M2 and M3 ran in the same folder, the M3 session's `git switch` moved the M2 session's branch too, and both sessions' `make up` drove the same Compose project and ports. Running milestones in parallel (`/work-backlog M2` in one session, `/work-backlog M3` in another) therefore takes one worktree per session, each with its own local stack.

**Create it** from the main checkout, in your own terminal (`<name>` names the session, e.g. `m3`):

```sh
git fetch origin
git worktree add --detach ../ineedtofocus-<name> origin/main
cp .env.example ../ineedtofocus-<name>/.env   # then set its project name and ports (below)
cd ../ineedtofocus-<name>
claude-focus                                  # then accept the workspace trust prompt
```

- `--detach` because a branch can be checked out in only one worktree. Agents create their `<agent>/<n>-<slug>` branches from there as usual.
- A worktree shares the repository (commits, branches, remotes and the stash) with the main checkout, but has its own files, current branch and git-ignored files: `.env`, `.claude/settings.local.json`, `backend/.venv` and `frontend/node_modules` (the first `make` target that needs them installs them).
- Start the session with `claude-focus`, so it acts as the agent account ([infra/github/README.md](../infra/github/README.md#agent-account-127)), and accept the trust prompt: trust is per folder, and the rules in `.claude/settings.json` apply only once it's accepted. Run git from the worktree's root ([AGENTS.md](../AGENTS.md#conventions)).

**Its own local stack.** The worktree's `.env` sets its own Compose project name, which keeps the containers, network, database volume and app image apart, and its own host ports. The main checkout keeps the defaults; the second worktree adds 10 to each port (`.env.example` lists the lines):

| Setting | Main checkout | Second worktree |
|---|---|---|
| `COMPOSE_PROJECT_NAME` | `focus-local` | `focus-<name>`, e.g. `focus-m3` |
| `APP_PORT` | 8000 | 8010 |
| `GRAFANA_PORT` | 3000 | 3010 |
| `OTLP_HTTP_PORT` / `OTLP_GRPC_PORT` | 4318 / 4317 | 4328 / 4327 |
| `POSTGRES_PORT` | 5432 | 5442 |
| `DATABASE_URL` (backend run on the host) | `…@localhost:5432/focus` | `…@localhost:5442/focus` |
| Vite dev server (no `.env` variable) | 5173 | 5183: `APP_PORT=8010 npm --prefix frontend run dev -- --port 5183` |

- `make up` prints the Compose project and the URLs Compose actually published (`scripts/stack-urls.sh`). `make check-stack` reads `APP_PORT` and `GRAFANA_PORT` from `.env`. It and `scripts/stack-urls.sh app` take `export NAME=value` lines there as well as `NAME=value`, as Compose does.
- `make test` and `make test-e2e` test this checkout's app: the port its stack publishes, or its `APP_PORT` while it's down. `PLAYWRIGHT_BASE_URL` still overrides that. The log-privacy e2e test reads `docker compose logs`, which picks up `COMPOSE_PROJECT_NAME` from `.env`.
- The backend integration tests take `DATABASE_URL` from the shell, never from `.env`. Without it they use the Postgres on port 5432, whichever checkout runs it, but each test creates and drops its own database, so that's harmless. To use the worktree's own: `DATABASE_URL=postgresql+asyncpg://focus:focus@localhost:5442/focus make test`.
- `.claude/settings.json` pre-approves `curl` on the second worktree's ports (8010, 5183, 3010, 4328, on `localhost` and `127.0.0.1`) as well as the defaults, so its unattended runs don't stall. A third parallel worktree adds 20 to each port and allows its own in its git-ignored `.claude/settings.local.json`, in the same explicit-port form:

  ```json
  {
    "permissions": {
      "allow": [
        "Bash(curl http://localhost:8020/*)", "Bash(curl * http://localhost:8020/*)",
        "Bash(curl http://localhost:5193/*)", "Bash(curl * http://localhost:5193/*)",
        "Bash(curl http://localhost:3020/*)", "Bash(curl * http://localhost:3020/*)",
        "Bash(curl http://localhost:4338/*)", "Bash(curl * http://localhost:4338/*)",
        "Bash(curl http://127.0.0.1:8020/*)", "Bash(curl * http://127.0.0.1:8020/*)",
        "Bash(curl http://127.0.0.1:5193/*)", "Bash(curl * http://127.0.0.1:5193/*)",
        "Bash(curl http://127.0.0.1:3020/*)", "Bash(curl * http://127.0.0.1:3020/*)",
        "Bash(curl http://127.0.0.1:4338/*)", "Bash(curl * http://127.0.0.1:4338/*)"
      ]
    }
  }
  ```

**Subagent worktrees.** A subagent the lead starts with worktree isolation gets a throwaway worktree under `<main checkout>/.claude/worktrees/`, even when the session runs in `../ineedtofocus-<name>`. `.gitignore` ignores that folder (#81), so it can't be committed. Such a worktree has no `.env`, so `make up` there would run as `focus-local` on the default ports and replace the main checkout's stack. A subagent that needs a stack first copies its session's `.env` (`cp <session folder>/.env .env`; the lead names its folder when it delegates). The session's one stack then runs that subagent's code.

A guard catches the subagent that forgets (#188). In a checkout whose path contains `/.claude/worktrees/` and that has no `.env`, `scripts/require-worktree-env.sh` stops `make up`, `make down`, `make logs`, `make check-stack` and `make test-e2e` before Compose runs, with a non-zero exit and the `cp` line above. `make test` skips its e2e step there, saying so, instead of testing the main checkout's stack as if it were the worktree's (it fails when `CI` is set). An explicit `PLAYWRIGHT_BASE_URL` gets past the guard on the e2e targets. With a `.env`, or outside `.claude/worktrees/` (the main checkout, a session worktree, CI's `/home/runner/work/…` checkout), every target behaves as before.

**Remove it** once the session's PRs are merged:

```sh
cd ../ineedtofocus-<name> && make down        # stop its stack; its database volume stays
cd ../ineedtofocus
git worktree remove ../ineedtofocus-<name>    # refuses while it has changes or untracked files
git worktree prune
```

`git worktree remove` deletes the folder, git-ignored files such as its `.env` included. The stopped stack's database volume (`focus-<name>_db-data`) stays until it's removed with `docker volume rm`, which asks first: deleting data is a [human gate](#human-gates).

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

**Why that approval holds against agents (#127):** agents act as the machine account `merciful-poseidon`, never as Yacine. It has write access to the repo and the board, which the whole loop needs (issues, PRs, merges, the board, the `rollback` workflow), but it isn't an administrator and isn't a reviewer of the `production` environment. Only listed reviewers can approve a deployment, only administrators can edit an environment or its protection rules, and the API never returns a secret's value. So no command run with the agent account can approve a prod deploy, remove the reviewer or read the prod key. Yacine is the only `production` reviewer, and administrators can't bypass the rule. The account can most likely **overwrite** the environment's secrets, since GitHub lets collaborators with write access set them. That could break prod deploys but not get one through: every run still waits for Yacine's approval, and a replaced SSH key can't log in to the server. The rules in `.claude/settings.json` stay as a second line: #126 denies starting `deploy-prod` and approving through `pending_deployments` or `approveDeployments`, and #52 denies `gh secret set` and asks before `gh api` calls on environments. Sessions start with `claude-focus` so `gh` and `git push` use that account; setup, checks and the residual risk (Yacine's own login on the same machine) are in [infra/github/README.md](../infra/github/README.md#agent-account-127).

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
