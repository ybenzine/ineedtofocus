# Session saves failing

Alert **Session saves failing (prod)** or **(dev)**, `alert=session-save-errors` (#33). It fires when more than 5% of the sessions submitted in the last 5 minutes failed with a server error (`outcome="error"`), with at least 10 sessions submitted. The on-call agent follows this runbook headless (#35), and a person can follow it too. Commands with `oncall_grafana.py` read Grafana with the read-only token ([observability.md](../observability.md#alerts-user-impact-not-resources)); a person can use the dashboard instead.

## Impact

People finish focus sessions and they don't reach the server. Nothing is lost: the app keeps every unsaved session in its offline queue and syncs it once saves work again (F13). Until then those sessions are missing from history on other devices, and a device that's wiped before syncing loses them. A client error (`rejected`: an invalid session, an ID conflict) doesn't count toward this alert.

In user terms: "X% of session saves are failing in <env>", with X from:

```bash
python3 scripts/oncall_grafana.py journey <env>   # save_error_rate, sessions_submitted
```

## Check

1. **How bad, since when.** `journey <env>` gives the alert's own numbers now. For the trend, run `prom 'sum(increase(focus_session_saves_total{service_name="ineedtofocus", deployment_environment_name="<env>", outcome="error"}[5m]))' --minutes 60`. Or open the dashboard **I Need To Focus: key journey (<env>)**, **Session saves** row.
2. **What fails.** Run `failed <env>`, which lists failed save and history requests as traces, then `trace <trace id>` on two or three of them. Look at the span's `exception.type`, the SQL child spans and `service.version` (the commit that served it). `errors <env>` gives the error log lines, each with its `trace_id`. Common causes:

   | You see | Likely cause |
   |---|---|
   | `exception.type` `InjectedSaveFault` (log line `unhandled exception`), and the startup warning `fault injection on: session saves fail on purpose` | **Fault injection** is on: `FAULT_SAVE_ERROR_PERCENT` in the server's `/opt/focus/<env>/.env` ([observability.md → Alert trigger](../observability.md#alert-trigger-fault-injection)). Not a release, not a code bug |
   | `OperationalError`, `ConnectionRefusedError`, or `TimeoutError` on the SQL spans, and `/readyz` failing | The database: Postgres down, restarting or out of disk. Also check the history alert, since loads fail too |
   | `ProgrammingError`, `UndefinedColumnError`, `UndefinedTableError` | The schema and the release disagree: a migration that didn't run, or a contract migration ([deployment.md → Schema compatibility](../deployment.md#schema-compatibility)) |
   | A Python exception in app code (`TypeError`, `KeyError`, `ValidationError` raised in a handler), starting with one `service.version` | A bug in a release |

3. **Did it start with a deploy?** Compare the alert's `started_at` with the latest deploy of that environment, as in [rollback.md → Check](rollback.md#check):
   - prod: `gh run list --workflow deploy-prod.yml --limit 5`
   - dev: `gh run list --workflow ci.yml --branch main --event push --limit 5` (the **Deploy to dev** job)
   - the commits since the previous release: `gh pr list --state merged --limit 10`, `git log --oneline -15 origin/main`.

   If the failing traces' `service.version` is the release deployed just before the errors began, and the previous release didn't fail, the deploy is the cause.

## Decide

| Finding | Decision |
|---|---|
| The errors started with a deploy, the previous release was fine, and no migration or contract change is involved | **Roll back** that environment to the last known-good release ([rollback.md](rollback.md)). Then fix forward with a PR |
| Fault injection (`InjectedSaveFault`) | **Escalate:** a rollback reads the same server `.env`, so it changes nothing, and there's no code to fix. `⛔ Needs Yacine: turn fault injection off on <env>`: set `FAULT_SAVE_ERROR_PERCENT=0` (or delete the line) in `/opt/focus/<env>/.env` and recreate the app. If the drill is planned, say it was detected as one |
| The database is down or full | **Escalate:** a person must act on the server (`⛔ Needs Yacine:` with the exceptions and the `/readyz` result). For a full disk, see [observability.md → Droplet disk alert](../observability.md#droplet-disk-alert-digitalocean-202) |
| A schema mismatch after a migration | **Fix forward**, never roll back: rolling back doesn't undo a migration ([rollback.md → Decide](rollback.md#decide)). Escalate if prod is badly broken |
| A bug not tied to a recent deploy (an edge case some input hits) | **Fix:** a PR on `oncall/<incident>-<slug>` with a regression test that fails before the fix |
| A rollback already ran for this incident and the errors go on | Don't roll back again, since each run goes one release further back. **Fix** or **escalate** |

## Act

- **Roll back:** [rollback.md → Act](rollback.md#act). In the on-call workflow, the agent writes the decision and the workflow's rollback job runs `gh workflow run rollback.yml -f env=<env>`, at most once per incident. Outside it, run that command once.
- **Fix:** branch `oncall/<incident>-<slug>` from `main`. Add a failing test that reproduces the error first (a backend unit or integration test under `backend/tests/`, named after the incident), then the fix. Open the PR with `Refs #<incident>`, not `Closes`: the incident closes when the alert resolves. In the on-call workflow, the agent commits, and the workflow pushes the branch and opens the PR as the on-call App. The reviewer reviews it, and the workflow merges it on Approve and green CI, which deploys it to dev. For a prod alert, the ask is `⛔ Needs Yacine: deploy the fix to prod for incident #<n>`: start **deploy-prod** with the merge commit as `tag`, once dev runs it, and approve it.
- **Escalate:** `⛔ Needs Yacine:` on the incident issue, with the evidence (trace IDs, numbers, times) and the exact ask, plus the `needs-yacine` label.

## Verify

- The alert goes back to Normal: `python3 scripts/oncall_grafana.py wait session-save-errors <env> normal --minutes 15`. It resolves on the first evaluation without the condition, which is usually within 6 minutes once the failures leave the 5-minute window.
- `journey <env>` shows `save_error_rate` back near 0, or `null` when there's no traffic.
- The queued sessions sync: `focus_session_saves_total{kind="sync", outcome="created"}` rises for a while after the fix.

## Report

On the incident issue: the timeline (UTC: alert start, detection, decision, action, resolution), the impact (peak error rate, sessions affected, how long), the cause with its evidence (trace IDs, `exception.type`, release), the action (the rollback run with From and To, or the fix PR), the verification, and follow-ups as new issues. Never include customer data: name users by opaque ID and requests by trace ID.
