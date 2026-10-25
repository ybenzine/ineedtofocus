# Runbooks

One runbook per alert. The on-call agent, woken by the alert workflow (`.github/workflows/oncall.yml`, #35), and any person follow them step by step. Written with #33–#35. The alert's `runbook` link points at its runbook here.

| Runbook | Alert |
|---|---|
| [`session-save-errors.md`](session-save-errors.md) | Session saves failing |
| [`history-latency.md`](history-latency.md) | History slow |

Shared procedures, used by the runbooks above:

| Procedure | When |
|---|---|
| [`rollback.md`](rollback.md) | Undo a deploy of dev or prod: `gh workflow run rollback.yml -f env=prod` (#30) |

Every runbook has the same sections: **Impact** · **Check** (dashboards, queries, recent deploys) · **Decide** (rollback vs fix) · **Act** · **Verify** · **Report** (incident summary on the issue).
