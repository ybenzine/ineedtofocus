# Final submission check (#37)

Checked on 2026-10-26 against the grading criteria, by the QA agent. One section per acceptance criterion of [#37](https://github.com/ybenzine/ineedtofocus/issues/37).

| AC | Verdict |
|---|---|
| 1. Fresh clone: `make up` and `make test` succeed | Pass |
| 2. Prod and dev reachable over HTTPS; latest prod deploy approved manually | Pass for now; finishes after Yacine's final prod deploy |
| 3. Board shows every closed issue linked to its PR | Pass, with 11 closed issues that have no closing PR (all explained below) |
| 4. Observability and on-call drill evidence present | Pass |
| 5. Submitted before 23:00 UTC | Pending, Yacine's action |

## 1. Fresh clone: `make up` and `make test`

**Verdict: pass.** Commit `16158ab` (main at the time of the check).

```sh
git clone https://github.com/ybenzine/ineedtofocus /tmp/qa37-clone
cd /tmp/qa37-clone
# .env: .env.example with COMPOSE_PROJECT_NAME=focus-qa37, APP_PORT=8020, GRAFANA_PORT=3020,
# OTLP_GRPC_PORT=4337, OTLP_HTTP_PORT=4338, POSTGRES_PORT=5462, SIGNUP_MAX_PER_CLIENT=1000
make up      # 36 s; app, db and lgtm healthy
make test    # exit 0, 7 min 6 s
make down    # removes this clone's containers and network only
```

The check used a separate Compose project and ports (8020 and so on) instead of the second worktree's 8010 set, because another stack already held 8010. Playwright ran against `http://localhost:8020`, this clone's own app (the default).

| Suite | Result |
|---|---|
| Backend unit and integration (pytest) | 647 passed |
| Frontend unit (Vitest) | 951 passed, 55 files |
| Repo scripts (pytest) | 1168 passed |
| Server bootstrap, production config checks | passed (shell test output, no failures) |
| Playwright end to end (Chromium) | 48 passed, none skipped |

## 2. Prod and dev over HTTPS; latest prod deploy approved manually

**Verdict: pass for now; this AC finishes after the final prod deploy.**

```sh
curl -sS -o /dev/null -w "%{http_code} %{content_type} ssl_verify=%{ssl_verify_result}\n" https://<host>/   # both hosts
curl -sS https://<host>/healthz
```

| Host | `/` | `/healthz` | Frontend |
|---|---|---|---|
| https://ineedtofoc.us | 200 text/html, certificate verifies | `{"status":"ok"}` | `<title>I Need To Focus</title>`, loads `/assets/index-D-BoHAGg.js` |
| https://dev.ineedtofoc.us | 200 text/html, certificate verifies | `{"status":"ok"}` | same title and bundle |

Prod deploys (`deploy-prod.yml`, one `workflow_dispatch` each, all run by `ybenzine`) and their `production` environment approvals, read with `gh api repos/ybenzine/ineedtofocus/actions/runs/<id>/approvals`:

| Run | Commit | Result | Approval |
|---|---|---|---|
| [40327763725](https://github.com/ybenzine/ineedtofocus/actions/runs/40327763725) (latest) | `d6bc665` | success | approved by `ybenzine` |
| [40216077765](https://github.com/ybenzine/ineedtofocus/actions/runs/40216077765) | `4c53bef` | success | approved by `ybenzine` |
| [40157949236](https://github.com/ybenzine/ineedtofocus/actions/runs/40157949236) | `3933745` | success | approved by `ybenzine` |

**Pending on Yacine:** main has moved since `d6bc665` (README #320, observability docs #322, the #317 drill's deliberately broken build #318 and its revert #321, which net out to a docs-only change, and this check). Yacine runs one final prod deploy of main after this PR merges and approves it in the `production` environment; the AC is done once that run is green and approved. Agents don't start or approve it.

## 3. Board shows every closed issue linked to its PR

**Verdict: pass; no unexplained gap.** Checked through REST: 149 closed issues (pull requests excluded) against 154 merged pull requests, matching `Closes/Fixes/Resolves #n` in each PR body. The Projects board itself (GraphQL) wasn't queried, to stay clear of the bot account's rate limit; its linked-PR column follows these same links.

138 of the 149 are closed by a merged PR. These 11 are not, and none needs fixing:

| Issue | Why there is no closing PR |
|---|---|
| #26 DNS in Route 53 | `owner:human` task, done by Yacine |
| #231, #319 Incident: Session saves failing (dev) | On-call incidents. #319 was closed by the on-call workflow (`github-actions[bot]`, its incident summary at 14:59:54 UTC) on resolve. #231 was closed by hand: the daily cap blocked its resolved run, so the product manager agent closed it (comment "closing incident #231 by hand", 2026-10-26 06:28:34 UTC) |
| #163, #182 Verify YouTube playback, wrap and non-embeddable video on dev | QA verification tasks, closed by the product manager agent's acceptance comments, not by a PR. #163: accepted 2026-10-25 06:39 UTC on QA's real-Chrome run on dev and Yacine's manual audio check. #182: accepted 17:46 UTC on QA's run (AC8.5 passed; AC8.4 taken as met through the #203 run). #182's run found the gap filed as #203, fixed by PR #206 (`Closes #203`) |
| #303 Flaky e2e: sync.spec.ts | Closed after the fix PR #301 merged (referenced, not a `Closes` line) |
| #147, #148, #150 Bug: tap targets and focus ring | Closed 2026-10-25 22:13 UTC by the product manager agent, each with "fixed by #225" (the Dusk theme PR, merged 22:06 UTC; the comment names it rather than a `Closes` line) |
| #166 Bug: deploy fails on a fresh host | Closed as not planned; the fix #171 merged and is referenced |
| #71 board-status.sh unknown status | Closed as not planned |

Issues worked by agents carry the start, PR-open and done comments from the templates in [process.md](process.md), for example #10 (start, PR open #87, done, QA verified, accepted). Exceptions: #52 has no comments, #26 is an `owner:human` task, #293 has no done comment and #312 has no PR-open comment.

## 4. Observability and on-call drill evidence

**Verdict: pass.**

- [observability.md](observability.md) covers signals, telemetry privacy, the user-impact alert rules, routing, the on-call agent and the dashboards.
- Dashboard screenshots: [key-journey saves and history](images/observability/key-journey-saves-history.png), [errors, logs, traces and routes](images/observability/key-journey-errors-http.png), [error log line to its trace](images/observability/error-log-to-trace.png) (all three files exist; section [Screenshots](observability.md#screenshots)).
- Alerts: [Alerts](observability.md#alerts-user-impact-not-resources) and [alert routing](observability.md#alert-routing-34).
- Escalation drill (#35): incident [#231](https://github.com/ybenzine/ineedtofocus/issues/231), [firing run](https://github.com/ybenzine/ineedtofocus/actions/runs/40276987971), [resolved run](https://github.com/ybenzine/ineedtofocus/actions/runs/40278298276), [write-up](https://github.com/ybenzine/ineedtofocus/issues/35#issuecomment-6409695167).
- Fix drill (#317): section [On-call drill: rollback of a bad deploy (#317)](observability.md#on-call-drill-rollback-of-a-bad-deploy-317) (runs, timeline and incident [#319](https://github.com/ybenzine/ineedtofocus/issues/319)) and the [evidence comment on #317](https://github.com/ybenzine/ineedtofocus/issues/317#issuecomment-6420041438), which exists.
- The README links all of this from its [On-call drills section](../README.md#on-call-drills), its links block and the grading table.

## 5. Submitted before 23:00 UTC

**Pending on Yacine.** AC2 and AC5 are finished only after the merge of this PR. Submission is his action, due 2026-10-26 23:00 UTC, and follows the final prod deploy in section 2.
