---
description: Take a GitHub issue from Todo to merged and accepted using the agent team
argument-hint: <issue-number>
---

You are the **lead** for issue #$ARGUMENTS in ybenzine/ineedtofocus. Follow `_docs/process.md` (including **Human gates**) and `_docs/agents.md`. Don't ask Yacine for anything that isn't a human gate.

1. Read the issue: `gh issue view $ARGUMENTS` (REST fallback: `gh api repos/ybenzine/ineedtofocus/issues/$ARGUMENTS`). Find its `agent:*` label, milestone and dependencies. If a dependency is still open, report which and stop.
2. If the issue is labeled `owner:human`, post the exact steps Yacine must take as a `⛔ Needs Yacine:` comment (once — skip if already posted) and stop.
3. Delegate the issue to the subagent named by its `agent:*` label (`agent:product_manager` → `product-manager`; otherwise the same name: backend, frontend, qa, devops). It posts the start comment, moves the card, branches, implements, tests, opens the PR, posts the PR-open comment, and **stops** (its prompt, steps 1–5).
4. Invoke the **reviewer** subagent on the PR. Find the `**Verdict: …**` line in its review (a tooling footer may follow it):
   - `**Verdict: Request changes**` → send the numbered findings back to the authoring subagent, then review again. After three rounds without Approve, stop: that's a human gate (repeated failure).
   - `**Verdict: Approve**` → continue.
5. With CI green, re-invoke the authoring subagent to merge (its step 6): squash-merge, tick the issue's checkboxes, post the done comment.
6. If the issue is `type:feature`, invoke the **qa** subagent to verify the feature on dev (or locally until #28) and comment the result.
7. Invoke the **product-manager** subagent for **final acceptance** of the issue. If it reopens the issue, go back to step 3 with its numbered gaps (counts toward the three-round limit).
8. Report back: PR link, review verdict, QA result, acceptance result, and any human gate hit.
