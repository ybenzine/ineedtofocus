# Process

How work moves from an issue to production. Every agent follows this; the reviewer agent enforces it.

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

Milestones (`M1`–`M5`) are the schedule; work the current milestone first, `P0` before `P1`. `post-mvp` issues are not touched before submission.

## Lifecycle of an issue

### 1. Pick up
- Take an open issue with **your** `agent:*` label in the current milestone, status Todo, whose dependencies are done.
- Post the start comment and move the card to **In progress**:

  > 🟡 **\<agent\> agent — started**
  > Branch `<agent>/<n>-<slug>`. Plan: \<2–4 bullets mapping to the ACs\>.

- If you're blocked (missing dependency, unclear AC, needs a human), comment `⛔ Blocked by #<n>` or `⛔ Needs Yacine: <exact ask>` and leave the card in Todo.

### 2. Build
- Branch from up-to-date `main`: `<agent>/<n>-<slug>`.
- Implement **exactly** the acceptance criteria. Scope questions go to the spec agent (comment on the issue), not into the code.
- Write the tests with the change (see [testing.md](testing.md)). Run `make lint` and `make test` before pushing.
- Small Conventional Commits that reference the issue (`feat(sessions): idempotent save — Refs #10`).

### 3. Open the PR
- Title: Conventional Commit style. Body from the PR template: `Closes #<n>`, each AC with how it's met, test evidence.
- Comment on the issue with the PR link and move the card to **In review**:

  > 🔵 **\<agent\> agent — PR open:** #\<pr\>. All ACs addressed; `make test` green.

### 4. Review
- The **reviewer agent** reads the issue and the PR and posts a review with one line per AC: ✅ met / ❌ not met (why) / ➖ not applicable (why), plus the definition-of-done checks.
- Verdict: **Approve** or **Request changes**. On changes, the author fixes and re-requests review; loop until approved.
- CI must be green (enforced by branch protection once #5 lands).

### 5. Merge
- After approval and green CI, the authoring agent **squash-merges**. Exceptions that need Yacine's approval first: PRs that change `.github/workflows/`, `infra/` used in production, or anything deployed to prod.
- On merge: the issue closes (`Closes #n`), the board moves it to Done, the branch is auto-deleted.
- The author ticks the satisfied checkboxes in the issue body and posts the closing comment:

  > ✅ **\<agent\> agent — done** in #\<pr\>. \<one line on anything notable or follow-ups (#n)\>.

### 6. Deploy
- Merge to `main` deploys to **dev** automatically. **Prod** is a manual, approved workflow run. See [deployment.md](deployment.md).

## Definition of done

An issue is done when **all** of these hold:

- [ ] Every acceptance criterion is met and checked off in the issue
- [ ] Tests added or updated; `make test` passes locally and in CI (docs-only changes: N/A, say so)
- [ ] PR says `Closes #<n>` and the reviewer agent approved it against the criteria
- [ ] Docs updated if behavior, setup or commands changed
- [ ] No secrets or customer data added to code, logs or telemetry

## Changing scope

- Only the **spec agent** edits `product_decisions.md`, and only after Yacine agrees.
- A requirement change updates, in one PR: `product_decisions.md`, the affected issue(s)' acceptance criteria, and a short note in the PR on why.
- New work found mid-task becomes a **new issue** (labels, milestone, ACs) instead of growing the current PR.

## Incidents

Production alerts wake the **on-call agent** (see [agents.md](agents.md)). It opens a `type:incident` issue, follows the matching runbook in [runbooks/](runbooks/), and either rolls back to the last known-good release or opens a fix PR with a regression test. Fix PRs go through the normal review above.
