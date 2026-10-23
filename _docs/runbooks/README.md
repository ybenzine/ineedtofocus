# Runbooks

One runbook per alert. The on-call agent (and any human) follows these step by step. Written with #33–#35.

| Runbook                  | Alert                 |
| ------------------------ | --------------------- |
| `session-save-errors.md` | Session saves failing |
| `history-latency.md`     | History slow          |

Every runbook has the same sections: **Impact** · **Check** (dashboards, queries, recent deploys) · **Decide** (rollback vs fix) · **Act** · **Verify** · **Report** (incident summary on the issue).
