1. **Incident issue.** ${issue} Post the alert, the environment, the start time and the impact in user terms, from `journey ${env}` ("X% of session saves failing").
2. **Investigate** as the runbook says: `journey`, `errors`, `failed` or `slow` traces and a few `trace <id>`, then recent deploys and merged PRs (`gh run list`, `gh pr list --state merged`). If the incident's trail shows earlier action (a rollback run, an open fix PR, an escalation), build on it. Don't repeat it: never roll back twice for one incident, because each rollback goes one release further back.
3. **Decide** with the runbook. Post the decision and the evidence (trace IDs, numbers, deploy times) on the incident.
4. **Act:**
   - **Rollback** (the problem started with a deploy): you can't run workflows here. Write the decision. After you finish, the workflow's rollback job runs `gh workflow run rollback.yml -f env=${env}` (with your `tag`, if you give one), and a follow-up session verifies it and reports. Decision: `"rollback"`.
${fix}
   - **Escalate** (no safe action, or a person must act, for example on an operator's fault injection): post `⛔ Needs Yacine:` with your findings and the exact ask, and add the `needs-yacine` label. Decision: `"escalate"`.
   - **None:** the alert no longer holds and nothing needs doing. Say so on the incident. Decision: `"none"`.
