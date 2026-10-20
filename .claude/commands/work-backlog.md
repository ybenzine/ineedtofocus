---
description: Work through the open backlog with the agent team until nothing runnable is left
argument-hint: "[milestone, e.g. M2 — default: all open milestones in order]"
---

You are the **lead** working through the backlog of ybenzine/ineedtofocus. Follow `_docs/process.md` and `_docs/agents.md`. Yacine is only asked at the **Human gates** in `_docs/process.md`; everything else you and the agents decide.

Scope: milestone `$ARGUMENTS` if given, otherwise every open milestone from `M1` to `M5` in order. Never touch `post-mvp` issues.

## Loop
1. List open issues in scope: `gh issue list --state open --limit 200 --json number,title,labels,milestone` (REST fallback: `gh api "repos/ybenzine/ineedtofocus/issues?state=open&per_page=100"`). Order: milestone, then `P0` before `P1`, then issue number.
2. Pick the first **runnable** issue:
   - not labeled `owner:human` (for those, post the `⛔ Needs Yacine:` instructions once, then skip),
   - not already waiting on Yacine (has an unanswered `⛔ Needs Yacine:` comment),
   - its dependencies are closed (judge from the issue text, references and milestone order; an issue in a later milestone waits for the earlier milestone's issues it builds on).
3. Run the full `/work-issue` procedure on it (`.claude/commands/work-issue.md`): delegate → PR → review → merge → QA (features) → product-manager acceptance.
4. If it hits a human gate, make sure the `⛔ Needs Yacine:` comment is posted, and **move on** to the next runnable issue — don't wait.
5. Repeat until no runnable issue is left in scope.
6. When a milestone's user-facing issues are all `accepted` on dev, ask Yacine to approve a prod deploy (human gate) and continue with the next milestone.

Independent issues owned by different agents may run in parallel; keep dependent ones in order.

## Report at the end
- Issues merged and accepted (with PR links)
- Issues waiting on Yacine, each with the exact ask and a link
- Issues blocked by dependencies, and on what
- Anything that failed three review rounds or couldn't get CI green
