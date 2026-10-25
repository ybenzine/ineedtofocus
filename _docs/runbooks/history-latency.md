# History slow

Alert **History slow (prod)** or **(dev)**, `alert=history-latency` (#33). It fires when the p95 latency of `GET /api/history` over the last 5 minutes is above 2 s, with at least 5 history loads that recorded a latency. The on-call agent follows this runbook headless (#35), and a person can follow it too. Commands with `oncall_grafana.py` read Grafana with the read-only token ([observability.md](../observability.md#alerts-user-impact-not-resources)); a person can use the dashboard instead.

## Impact

The history screen (day, week, month, all time, custom range: F10) takes over 2 seconds for one load in twenty, or worse. Timers and saves aren't affected unless the cause is shared (the database). In user terms: "History loads take <p95> at p95 in <env>", from:

```bash
python3 scripts/oncall_grafana.py journey <env>   # history_p95_seconds, history_loads
```

## Check

1. **How slow, since when.** `journey <env>` gives the alert's own numbers. For the trend, run `prom 'histogram_quantile(0.95, sum by (le) (increase(focus_history_load_duration_seconds_bucket{service_name="ineedtofocus", deployment_environment_name="<env>"}[5m])))' --minutes 60`. Or open the dashboard **I Need To Focus: key journey (<env>)**, **History loads** row, whose latency panel has exemplars that open a slow load's trace.
2. **Where the time goes.** Run `slow <env>`, which lists key-journey requests over 1 s, then `trace <trace id>` on two or three. Compare the server span's duration with its SQL child spans:

   | You see | Likely cause |
   |---|---|
   | One SQL span takes most of the time, and its statement changed in a recent release | A query regression: a missing index, a query over every session, a lost `WHERE` |
   | Every SQL span is slow, saves are slow too (`focus_session_save_duration_seconds`), and connection errors appear | The database or the host: load, disk, a long-running migration or vacuum |
   | Little time in SQL, a lot in the handler | Grouping in Python (time zones, weeks) over a large range, a regression in app code |
   | Slow only for some requests, those with a long `custom` range or `all` | One heavy user or range, not a release. Check whether it's sustained or a few loads |

3. **Did it start with a deploy?** Compare the alert's `started_at` with the latest deploy, as in [rollback.md → Check](rollback.md#check) (`gh run list --workflow deploy-prod.yml --limit 5`, or `ci.yml` on `main` for dev). Compare `service.version` on the slow traces with the one before the deploy. List the merged PRs since then (`gh pr list --state merged --limit 10`) and look for changes to `backend/app/` history code, queries or migrations.

## Decide

| Finding | Decision |
|---|---|
| It started with a deploy, the previous release was fast, and no migration is involved | **Roll back** that environment ([rollback.md](rollback.md)), then fix forward with a PR |
| A new migration (an index dropped, a column changed) | **Fix forward**: a rollback doesn't undo a migration |
| The database or host is slow for everything | **Escalate:** `⛔ Needs Yacine:` with the traces and numbers. The server needs a person |
| A query or code regression not tied to a recent deploy | **Fix:** a PR on `oncall/<incident>-<slug>` with a regression test (for example a test that the query uses the index, or that grouping stays within a time budget on a large fixture) |
| A few heavy loads, then it resolves without any change | **None:** record it, and open a follow-up issue if one range is reliably slow |
| A rollback already ran for this incident and it's still slow | Don't roll back again. **Fix** or **escalate** |

## Act

- **Roll back:** [rollback.md → Act](rollback.md#act). In the on-call workflow, the agent writes the decision and the workflow's rollback job runs `gh workflow run rollback.yml -f env=<env>`, at most once per incident. Outside it, run that command once.
- **Fix:** branch `oncall/<incident>-<slug>` from `main`. Add a failing regression test first, then the fix, and open the PR with `Refs #<incident>`, not `Closes`: the incident closes when the alert resolves. In the on-call workflow, the agent commits, and the workflow pushes the branch and opens the PR as the on-call App. The reviewer reviews it, and the workflow merges it on Approve and green CI, which deploys it to dev. For a prod alert, Yacine starts **deploy-prod** with the merge commit as `tag` and approves it.
- **Escalate:** `⛔ Needs Yacine:` on the incident issue with the evidence and the exact ask, plus the `needs-yacine` label.

## Verify

- The alert goes back to Normal: `python3 scripts/oncall_grafana.py wait history-latency <env> normal --minutes 15`.
- `journey <env>` shows `history_p95_seconds` under 2, or `null` when there's no traffic.
- `slow <env>` lists no new history loads over 1 s.

## Report

On the incident issue: the timeline (UTC), the impact (peak p95, how long), the cause with its evidence (trace IDs, the slow span, the release), the action (the rollback run with From and To, or the fix PR), the verification, and follow-ups as new issues. Never include customer data: name users by opaque ID and requests by trace ID.
