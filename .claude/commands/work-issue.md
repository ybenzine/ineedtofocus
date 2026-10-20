---
description: Take a GitHub issue from Todo to merged and accepted using the agent team
argument-hint: <issue-number>
---

You are the **lead** for issue #$ARGUMENTS in ybenzine/ineedtofocus. Follow `_docs/process.md` (including **Human gates**) and `_docs/agents.md`. Don't ask Yacine for anything that isn't a human gate.

1. Read the issue: `gh issue view $ARGUMENTS` (REST fallback: `gh api repos/ybenzine/ineedtofocus/issues/$ARGUMENTS`). Find its `agent:*` label, milestone and dependencies. If a dependency is still open, report which and stop.
2. **Human part first:** if the issue is labeled `owner:human` and hasn't had its human steps done yet, post the exact steps Yacine must take as a `⛔ Needs Yacine:` comment, add the `needs-yacine` label, and stop. Once Yacine has removed the label, continue with the issue's agent part (if it also has an `agent:*` label) from step 3; if it has none, go straight to step 7, where the acceptor also **closes** the issue on acceptance.
   **Resume, don't restart:** if the issue already has an open PR (`gh pr list --state open --search "Closes #$ARGUMENTS"`; REST fallback: `gh api --paginate "repos/ybenzine/ineedtofocus/pulls?state=open&per_page=100"` and match a body containing `Closes #$ARGUMENTS`), skip to step 4 with that PR.
   **Closed but not accepted:** if the issue is closed and lacks the `accepted` label, skip to step 6.
3. Delegate the issue to the subagent named by its `agent:*` label (`agent:product_manager` → `product-manager`; otherwise the same name: backend, frontend, qa, devops). It posts the start comment, moves the card, branches, implements, tests, opens the PR, posts the PR-open comment, and **stops** (its prompt, steps 1–5).
4. Invoke the **reviewer** subagent on the PR. Find the `**Verdict: …**` line in its review (a tooling footer may follow it):
   - `**Verdict: Request changes**` → send the numbered findings back to the authoring subagent, then review again. After three rounds without Approve, stop: that's a human gate (repeated failure).
   - `**Verdict: Approve**` → continue.
5. If CI is red, send the failures back to the authoring subagent; after three fix attempts with CI still red, stop (human gate: repeated failure). With CI green, re-invoke the authoring subagent to merge (its step 6): squash-merge, tick the issue's checkboxes, post the done comment.
6. If the issue is `type:feature`, invoke the **qa** subagent to verify the feature on dev (or locally until #28) and comment the result.
7. **Final acceptance:** invoke the **product-manager** subagent — or the **qa** subagent if the issue is owned by the product manager, so nobody accepts their own work. If it reopens the issue, go back to step 3 with its numbered gaps (counts toward the three-round limit). Every gate hit gets the `needs-yacine` label.
8. Report back: PR link, review verdict, QA result, acceptance result, and any human gate hit.
