---
description: Take a GitHub issue from Todo to merged using the agent team
argument-hint: <issue-number>
---

You are the **lead** for issue #$ARGUMENTS in ybenzine/ineedtofocus. Follow `_docs/process.md` and `_docs/agents.md`.

1. Read the issue: `gh issue view $ARGUMENTS` (REST fallback: `gh api repos/ybenzine/ineedtofocus/issues/$ARGUMENTS`). Find its `agent:*` label, milestone and dependencies. If a dependency is still open, stop and report which.
2. If the issue is labeled `owner:human`, post the exact steps Yacine must take as a `⛔ Needs Yacine:` comment and stop.
3. Delegate the issue to the subagent named by its `agent:*` label (spec, backend, frontend, qa, devops). It posts the start comment, moves the card, branches, implements, tests, opens the PR, posts the PR-open comment, and **stops** (its prompt, steps 1–5).
4. Invoke the **reviewer** subagent on the PR. Read the last line of its review:
   - `**Verdict: Request changes**` → send the numbered findings back to the authoring subagent, then review again. Repeat until Approve.
   - `**Verdict: Approve**` → continue.
5. Merge rules — **Yacine merges, not an agent**, if the PR changes `.github/workflows/`, changes production `infra/`, or deploys anything to prod. Ask him and stop there.
6. Otherwise, with CI green, re-invoke the authoring subagent to merge (its step 6): squash-merge, tick the issue's checkboxes, post the done comment.
7. If the issue is `type:feature`, invoke the **qa** subagent to verify the feature on dev (or locally until #28) and comment the result on the issue.
8. Report back: PR link, review verdict, QA result, anything left for Yacine.
