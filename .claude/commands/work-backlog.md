---
description: Work through the open backlog with the agent team until nothing runnable is left
argument-hint: "[milestone prefix, e.g. M2 — default: all milestones M1–M5 in order]"
---

You are the **lead** working through the backlog of ybenzine/ineedtofocus. Follow `_docs/process.md` and `_docs/agents.md`. Yacine is only asked at the **Human gates** in `_docs/process.md`; everything else you and the agents decide.

**Scope:** issues whose milestone title starts with `$ARGUMENTS` (e.g. `M2` matches `M2 · MVP app`); if no argument, every milestone `M1`–`M5` in order. Never touch `post-mvp` issues or the `Post-MVP` milestone.

## Collect
1. Open issues: `gh issue list --state open --limit 500 --json number,title,labels,milestone` (REST fallback: `gh api --paginate "repos/ybenzine/ineedtofocus/issues?state=open&per_page=100"`, then drop entries that have a `pull_request` key — those are PRs).
2. **Closed but not accepted:** closed issues in scope, closed as completed, without the `accepted` label (`gh issue list --state closed --json number,labels,milestone,stateReason`). They still need acceptance.
3. **Needs triage:** open issues with no milestone or no `agent:*`/`owner:human` label. Ask the **product-manager** subagent to triage them before continuing.
4. Order everything by milestone, then `P0` before `P1`, then issue number.

## Loop
1. Pick the first **runnable** issue, where runnable means:
   - it is not labeled `needs-yacine` (still waiting on Yacine),
   - its dependencies are closed (judge from the issue text, references and milestone order; an issue in a later milestone waits for the earlier-milestone issues it builds on).
   `owner:human` issues are runnable: `/work-issue` posts the human steps and labels them, or continues with the agent part once Yacine has removed `needs-yacine`.
2. Run the full `/work-issue` procedure on it (`.claude/commands/work-issue.md`). It resumes an existing PR instead of starting over, and handles closed-but-not-accepted issues by going straight to acceptance.
3. If it hits a human gate, make sure the issue has the `⛔ Needs Yacine:` comment and the `needs-yacine` label, then **move on** to the next runnable issue — don't wait.
4. Repeat. Each issue is attempted **at most once per run**: an issue that ends this run still open, unaccepted or labeled goes into the report, not back into the queue. Stop when no runnable issue is left.
5. When every user-facing issue of a milestone is `accepted` on dev: if the prod deploy workflow exists (#29), ask Yacine to approve a prod deploy (human gate, `needs-yacine` on the milestone's last issue); before #29, just note "ready for prod" in the report. Then continue with the next milestone.

Independent issues owned by different agents may run in parallel; keep dependent ones in order.

## Report at the end
- Merged and accepted this run (issue → PR links)
- Waiting on Yacine (`needs-yacine`), each with the exact ask and a link
- Blocked by dependencies, and on what
- Triaged by the product manager
- Hit the repeated-failure gate (three review rounds or three red CI attempts)
- Closed but still not accepted, and why
