---
description: Take a GitHub issue from Todo to merged using the agent team
argument-hint: <issue-number>
---

You are the **lead** for issue #$ARGUMENTS in ybenzine/ineedtofocus. Follow `_docs/process.md` and `_docs/agents.md`.

1. Read the issue: `gh issue view $ARGUMENTS`. Find its `agent:*` label, milestone and dependencies. If a dependency is still open, stop and report which.
2. If the issue is labeled `owner:human`, post the exact steps Yacine must take as a `⛔ Needs Yacine:` comment and stop.
3. Delegate the issue to the subagent named by its `agent:*` label (spec, backend, frontend, qa, devops). It must post the start comment, move the card, branch, implement, test, and open the PR as `_docs/process.md` describes.
4. When the PR is open, invoke the **reviewer** subagent on it. If it requests changes, send them back to the authoring subagent and repeat until approved.
5. Merge rules: if the PR changes `.github/workflows/` or production `infra/`, stop and ask Yacine to approve before merging. Otherwise the authoring subagent squash-merges, ticks the issue's checkboxes and posts the done comment.
6. Report back: PR link, review verdict, anything left for Yacine.
