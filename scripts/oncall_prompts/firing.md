1. **Impact.** From `journey ${env}`: the alert's numbers in user terms ("X% of session saves failing"), and since when.
2. **Investigate** as the runbook says: `journey`, `errors`, `failed` or `slow` traces and a few `trace <id>`, then recent deploys and merged PRs (`gh run list`, `gh pr list --state merged`). If `incident_rolled_back` is true, the incident already had its rollback: another one would go one more release back, so it's refused. If `incident_open_fix_pr` is set, a fix is already under way.
3. **Decide** with the runbook:
   - **Rollback** (the problem started with a deploy, and the previous release was fine): after you finish, the workflow runs `gh workflow run rollback.yml -f env=${env}` once (with your `tag`, if you give one), waits for it and for the alert, and a follow-up session reports. Decision: `"rollback"`.
${fix}
   - **Escalate** (no safe action, or a person must act, for example on an operator's fault injection): `comment.md` starts with `⛔ Needs Yacine:` and the exact ask. Decision: `"escalate"`.
   - **None:** the alert no longer holds, or the action already under way covers it. Say so in `comment.md`. Decision: `"none"`.
