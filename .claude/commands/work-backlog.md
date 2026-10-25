---
description: Work through the open backlog with the agent team until nothing runnable is left
argument-hint: "[milestone prefix, e.g. M2 — default: all milestones M1–M5 in order]"
---

You are the **lead** working through the backlog of ybenzine/ineedtofocus. Follow `_docs/process.md` and `_docs/agents.md`. Yacine is only asked at the **Human gates** in `_docs/process.md`; everything else you and the agents decide. Post every comment and issue body from a file, never inline (`_docs/process.md` → Posting to the tracker).

**Scope:** issues whose milestone title starts with `$ARGUMENTS` (e.g. `M2` matches `M2 · MVP app`); if no argument, every milestone `M1`–`M5` in order. Never touch `post-mvp` issues or the `Post-MVP` milestone.

**Parallel milestones need separate worktrees** (#83): two `/work-backlog` sessions never run in the same folder. Each runs in its own git worktree with its own `.env` (Compose project name and host ports), set up as in `_docs/process.md` → Parallel sessions.

## Collect
1. Open issues: `gh issue list --state open --limit 500 --json number,title,labels,milestone` (REST fallback: `gh api --paginate "repos/ybenzine/ineedtofocus/issues?state=open&per_page=100"`, then drop entries that have a `pull_request` key — those are PRs).
2. **Closed but not accepted:** closed issues in scope, closed as completed, without the `accepted` label: `gh issue list --state closed --limit 500 --json number,labels,milestone,stateReason` (REST fallback: `gh api --paginate "repos/ybenzine/ineedtofocus/issues?state=closed&per_page=100"`, drop entries with a `pull_request` key, keep `state_reason == "completed"`). They still need acceptance.
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
5. When every user-facing issue of a milestone is `accepted` on dev: if the prod deploy workflow exists (#29), ask Yacine **once** to approve a prod deploy (human gate, `needs-yacine` on the milestone's last issue) — skip if a prod-deploy ask for that milestone already exists, answered or not; before #29, just note "ready for prod" in the report. Then continue with the next milestone.

Independent issues owned by different agents may run in parallel; keep dependent ones in order. **At most 4 subagents run at once per session** (#172; `.claude/settings.json` sets the cap, `_docs/agents.md` → Orchestration). A workflow run has its own cap of 4 per run, so subagents plus a workflow can add up to more than 4. If a spawn fails with `Concurrent subagent limit reached`, don't retry: wait for a running agent to finish, then spawn. Two parallel sessions mean at most 8 subagents in total. Resuming a finished subagent and `/subtask` forks can push the count past 4, so count them too. Sessions with ultracode on don't enforce the subagent limit, though the per-run workflow cap still applies, so don't turn ultracode on.

## Report at the end
- Merged and accepted this run (issue → PR links)
- Waiting on Yacine (`needs-yacine`), each with the exact ask and a link
- Blocked by dependencies, and on what
- Triaged by the product manager
- Hit the repeated-failure gate (three review rounds or three red CI attempts)
- Closed but still not accepted, and why
