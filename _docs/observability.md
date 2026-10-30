# Observability

Instrumented in #31; Grafana Cloud wiring and the key-journey dashboards in #32; the user-impact alert rules, the fault-injection trigger and the traffic script in #33; routing alerts to the on-call workflow in #34; the on-call agent that workflow runs in #35 ([below](#on-call-agent-35)).

## Key user journey

Save a finished session (including offline sync batches) and load history.

## Signals

- **Traces:** every request is a FastAPI server span (`/healthz` is not traced), with a child span per SQL statement from the SQLAlchemy instrumentation (`app/telemetry.py`, `instrument_engine`; the stock instrumentor refuses SQLAlchemy 2.1, so the engine is wired directly). `db.statement` is the parameterised SQL (`$1`, `$2`), never bound values. The browser sends a W3C `traceparent` header on saves, sync batches, history loads and archive calls (`frontend/src/telemetry/tracedFetch.ts`), and the server continues that trace, so one trace ID covers click to database. The browser does not export spans, so the parent span ID in that header never arrives: Tempo shows the server span with a missing parent ("root span not yet received"). That is expected and harmless. Signed-in requests carry `enduser.id`, the opaque user UUID, on the server span.
- **Metrics** (`app/metrics.py`, OTLP, fixed low-cardinality labels):

  | Metric | Type | Labels |
  |---|---|---|
  | `focus.session.saves` | counter, per session | `kind` (single, sync); `outcome` (created, existing, rejected, error) |
  | `focus.session.save.duration` | histogram, seconds, per request | `kind`; `outcome` (ok, client_error, error) |
  | `focus.sync.batch.size` | histogram, sessions per sync request | none |
  | `focus.history.loads` | counter, per request | `outcome` (ok, invalid, error) |
  | `focus.history.load.duration` | histogram, seconds | `outcome` (ok, client_error, error) |

  The duration histograms use second-based buckets with an edge at 2 s (the history alert threshold); the SDK defaults are in milliseconds and would put every request in one bucket.

  What the outcomes cover: a failure inside the handler counts as `rejected` (the client's mistake: a conflict, an invalid session) or `error`. A failure before the handler, namely FastAPI's own 422 validation and an unexpected error such as the sign-in lookup failing during a database outage, is counted by the error handlers (`app/errors.py`): `rejected` or `invalid` for 422, `error` for the rest, once per request (a sync batch that fails that early counts as one). Requests answered 401 or 429 never reach a save or a load and are not counted. The duration histograms time the handler only (after authentication), and only for requests that reach it. The save error rate is `outcome="error"` over all `focus.session.saves`.
- **How the signals link:** logs, traces and metrics share the trace ID. In Grafana: a log line's `trace_id` links to the trace in Tempo; a trace shows its logs; the journey histograms carry exemplars (the OTel SDK attaches the trace ID of the sampled request to a measurement), so a latency panel point opens the trace behind it (enable exemplars on the panel). `make check-stack` proves all three links on a real save: the trace has the request and its SQL spans, Loki has the save's log line with that `trace_id`, and Prometheus has an exemplar with that `trace_id`.
- **Logs:** one JSON object per line on stdout, also shipped over OTLP. Every line has `trace_id` and `span_id` (32 and 16 hex characters; `null` outside a request, e.g. at startup), the same IDs as the spans, so Grafana jumps between a log line and its trace. Only the `extra=` fields in `ALLOWED_EXTRA` (`app/logging_config.py`) are kept; uvicorn's `color_message` (ANSI codes) never ships.

## Telemetry privacy (non-negotiable)

Never sent to logs, traces or metrics: email addresses, passwords, cookies or session tokens, session goals, YouTube links and titles. Users appear only as an opaque internal ID. Enforced by allowlists and covered by tests (`tests/unit/test_telemetry.py`, `tests/unit/test_logging_fields.py`, `tests/integration/test_journey_telemetry.py`):

- **Span attributes:** only names in `ALLOWED_SPAN_ATTRIBUTES` leave the process (no user agent, client address, headers, cookies); exception events keep the type only and span status keeps the code but not the description (both can quote database rows or bound values). The allowlist runs first in the span-processor chain, before the exporter queues the span.
- **Paths and queries:** `url.query` is `REDACTED`. `url.path` and the path inside `url.full`, `http.url` and `http.target` are the route template (`/api/sessions/{session_id}`) for a matched request and `UNMATCHED` otherwise, so an email or an encoded YouTube link typed into a URL is never exported. The API contract therefore keeps emails, goals and YouTube links out of paths too.
- **Log fields:** the `extra=` allowlist above; message and exception text are scrubbed of Postgres `DETAIL` lines, SQL parameters, asyncpg's `invalid input for query argument $N: '<value>'` and ANSI codes. The save and sync handlers log one line each (`session saved`, `sessions synced`) so a trace has a log to link to.
- **Metric labels:** only the fixed words in the table; never a user, tag, goal or time zone.

## Alerts (user impact, not resources)

Two Grafana-managed alert rules per environment (#33), on the key journey only. None on CPU, memory or any other resource ([tech_stack.md §4](tech_stack.md)); `scripts/tests/test_grafana_alerts.py` fails if a rule queries anything but the journey metrics. The one recorded exception, a disk-usage alert outside Grafana that emails Yacine and doesn't wake the on-call agent, is the [Droplet disk alert](#droplet-disk-alert-digitalocean-202) (#202).

| Alert | Fires when | Queries (Prometheus, last 5 minutes) |
|---|---|---|
| **Session saves failing** | More than 5% of the sessions submitted failed, with at least 10 sessions submitted | A: `outcome="error"` over all `focus_session_saves_total`, the complement of the dashboards' save success rate, so a `rejected` session doesn't count. B: the sessions submitted, only when at least 10 (`… >= 10`). Condition: `$A > 0.05 && $B >= 10` |
| **History slow** | The p95 latency of `GET /api/history` is above 2 s, with at least 5 history loads | A: `histogram_quantile(0.95, …focus_history_load_duration_seconds_bucket…)`; 2 s is a bucket edge, so the estimate is exact at the threshold. B: the history loads that recorded a latency (`focus_history_load_duration_seconds_count`, the samples behind A, whatever their outcome), only when at least 5 (`… >= 5`). Condition: `$A > 2 && $B >= 5` |

- **Evaluation:** every minute; a rule fires once its condition has held for one more minute (pending period `1m`), and resolves on the first evaluation where it no longer holds. A sudden outage therefore fires about 2 minutes after it starts; the 5-minute window keeps a short blip from firing.
- **The minimum counts** stop one failed save or one slow history load at 3 a.m. from paging anyone. Below the minimum, query B returns nothing, so the window is "no data" and the rule stays Normal: it isn't a false condition, and it never fires. The save minimum is per session, not per request: a sync batch of 5 counts 5, as in the error rate. The history minimum (5 loads, the product manager's decision on #33) counts only the loads that recorded a latency, the samples A's p95 is computed from (#208). That's every load that reached the handler, whatever its outcome, including one the handler rejects (a time zone it doesn't know). A request FastAPI rejects with a 422 before the handler (a missing or malformed parameter) records no latency, so it doesn't count: otherwise 4 of them and 1 slow load would meet the minimum with a p95 of a single sample, and page. `focus_history_loads_total` still counts every request, for the dashboards' loads-by-outcome and error-rate panels.
- **Quiet periods are "no data", and no data is OK.** The journey counters exist from startup at 0 (below), so a 5-minute window without traffic is 0/0 (or a quantile of nothing), which is NaN, and Grafana takes a NaN condition as true. Each query therefore filters with `> 0`, which turns that into no data. A query that fails keeps the rule's last state (`execErrState: KeepLast`): a broken Grafana Cloud query isn't user impact, and it would otherwise raise an alert of its own.
- **Fresh outages count.** A counter series only exists from its first increment, and `increase()` needs two samples, so the first burst of errors after a start would be invisible: the error series would appear already at its burst value and the error rate would read 0. The app therefore adds 0 to every `kind` × `outcome` of `focus.session.saves` and every `outcome` of `focus.history.loads` at startup (`zero_journey_series` in `app/metrics.py`). The latency histograms aren't zero-initialised, so after a start the loads in the history histogram's first export (one metric export interval: 15 s locally, the SDK's 60 s deployed) count toward neither A nor B. Both queries see the same samples, so this can delay the history alert after a restart but never make it page.
- **Labels** `service=ineedtofocus`, `environment=<env>`, `alert=session-save-errors|history-latency`; the routing (#34) and the on-call agent (#35) go by them. **Annotations:** a summary, a description with the values (e.g. "19.67% of the 65 sessions submitted in the last 5 minutes failed"), the runbook (`_docs/runbooks/<alert>.md`) and the dashboard panel behind the alert.

The rules are generated, like the dashboards, from one model, `scripts/grafana_alerts.py`, which builds the queries with `scripts/grafana_dashboards.py`'s selectors so the two can't drift: `infra/grafana/alerts/key-journey-prod.json`, `-dev.json` and `-local.json`, in Grafana's alert provisioning format (what Grafana's own export writes). Each environment's group filters on its own `deployment_environment_name`. **Changing a rule:** edit the script, run `python3 scripts/grafana_alerts.py`, commit the JSON with it (`make test-scripts` fails when they differ), and after the merge re-apply it to Grafana Cloud ([below](#apply-the-alert-rules-to-grafana-cloud)).

**Locally**, `make up` provisions `key-journey-local.json` into grafana/otel-lgtm (**Alerting → Alert rules → I Need To Focus**). `make check-stack` (in CI too) checks that the rules are provisioned and evaluate without errors, that each of their queries runs, and that every metric selector in them returns series after its probe's save and history load (`python3 scripts/grafana_alerts.py verify`). So a renamed metric or label can't leave a rule quietly evaluating nothing. It checks the selectors, such as `focus_session_saves_total{…, outcome="error"}`, rather than the whole expressions, because those are "no data" by design when the window holds too little traffic: after one history load the latency series exists, but its p95 needs a second sample. The error-outcome series exists only thanks to the zero-initialisation, so this also checks that. Locally the rules have no contact point, so a firing alert shows in the UI only.

### Alert trigger: fault injection

`FAULT_SAVE_ERROR_PERCENT` (0 to 100, default **0, off**) makes that share of session save requests (`POST /api/sessions` and `POST /api/sessions/sync`) fail on purpose (`app/faults.py`). Only the operator can change it:

- It's an environment variable the app reads once at startup. No endpoint reads, shows or changes it (`tests/unit/test_faults.py` checks the routes and the OpenAPI schema), so no user can turn it on.
- Deployed, it comes only from the server's `/opt/focus/<env>/.env`. `infra/compose.prod.yml` defaults it to 0, `infra/env/<env>.env` never sets it (it would win over the server file), and `make test-infra` checks both.
- When it's on, the app logs a warning at startup: `fault injection on: session saves fail on purpose`, with `fault_save_error_percent`.

A request picked to fail raises `InjectedSaveFault` before anything is written, so it fails like a real server error: the client gets a 500 and keeps the session in its offline queue to retry later (nothing is lost), every session in the request counts as `outcome="error"`, and the log line (`unhandled exception`) and the trace carry the exception type `InjectedSaveFault`. That's how whoever is on call tells an injected fault from a real one. A rollback doesn't clear it, since the rolled-back app reads the same server file.

**Fire the save alert on dev** (the operator, on the server). The server runs its own copy of `infra/` in `/opt/focus/infra`, and only `install.sh` updates it ([deployment.md → Infra on the server](deployment.md#infra-on-the-server-installsh)). A copy from before #33 doesn't pass the variable to the app, so editing `.env` and recreating the app silently changes nothing (found in #35's drill, #232):

1. **Check the installed infra has #33.** `cat /opt/focus/infra/REVISION` prints the installed commit. It must be #33's merge, `68fe0e4`, or a later commit on `main`: from a checkout, `git fetch origin && git merge-base --is-ancestor 68fe0e4 <revision> && echo ok`. If it isn't, install `main` first: `sudo /opt/focus/infra/server/install.sh <sha on main>`, read the diff, type `yes`.
2. Add `FAULT_SAVE_ERROR_PERCENT=30` to `/opt/focus/dev/.env`. Then recreate the app from the installed copy, with the tag dev runs now (`docker inspect --format '{{.Config.Image}}' focus-dev-app-1` shows it after the `:`): `cd /opt/focus/infra && APP_TAG=<current dev tag> ./compose.sh dev up -d app`.
3. **Check the app has it:** `docker exec focus-dev-app-1 env | grep FAULT` prints `FAULT_SAVE_ERROR_PERCENT=30`, and the app's log has the startup warning `fault injection on: session saves fail on purpose`. If the variable is missing, go back to step 1.
4. From any machine: `python3 scripts/traffic.py --base-url https://dev.ineedtofoc.us --minutes 10`.
5. **Session saves failing (dev)** goes pending, then fires, within about 3 minutes.
6. Delete the line (or set it to 0) and recreate the app the same way, from `/opt/focus/infra`. `docker exec focus-dev-app-1 env | grep FAULT` then prints nothing (or `=0`). The alert resolves within about 6 minutes, once the failures have left its 5-minute window.

### Traffic script

`scripts/traffic.py` sends realistic key-journey traffic. It signs up its own throwaway account (`traffic-<random>@example.com`, with a random password it never prints), then sends single saves (about 45%), offline sync batches of 2 to 5 sessions (15%; some repeat a session already saved, and now and then one holds an invalid session) and history loads over every view and a few time zones (40%). The default is 20 requests a minute for 10 minutes (`--rate`, `--minutes`; at most 120 a minute), enough to clear the save alert's minimum many times over without loading dev's small Droplet. It prints a line a minute, by result. Without fault injection almost nothing fails, so no alert fires. Each run leaves its throwaway account and the sessions it saved on the target (dev or your local stack); nothing cleans them up, and they are harmless there. It refuses to run against production (`ineedtofoc.us`): prod's alerts page the on-call agent, and its data is real users'. The check is by host name, which is enough because Caddy routes by host, so no other name or bare IP reaches prod. The default target is this checkout's local stack (`APP_PORT`).

### Proof on the local stack

On 2026-10-25, on a freshly started local stack (so the error series were new, the case the zero-initialisation is for): the app recreated with `FAULT_SAVE_ERROR_PERCENT=30` at 08:35:01Z, then `python3 scripts/traffic.py --rate 30 --minutes 9`, and at 08:38:30Z the app recreated with it back at 0 while the traffic went on. Times UTC:

```text
$ python3 scripts/grafana_alerts.py wait session-save-errors firing
08:35:31Z  session-save-errors: normal
08:36:51Z  session-save-errors: pending
08:37:51Z  session-save-errors: firing
$ python3 scripts/grafana_alerts.py wait session-save-errors normal
08:38:36Z  session-save-errors: firing
08:43:46Z  session-save-errors: normal
```

It fired 2 min 50 s after fault injection went on, and resolved 5 min 16 s after it went off. Grafana's description of the firing alert read "19.67% of the 64.96 sessions submitted in the last 5 minutes failed" (the count is a whole number now). The traffic script's total: 118 single saves ok and 15 failed, 37 sync batches ok and 2 failed, 110 history loads ok; **History slow** stayed normal throughout. `python3 scripts/grafana_alerts.py wait <rule> firing|pending|normal` waits for a local rule's state, for drills like this one.

**The history minimum**, the same day, with synthetic history metrics pushed over OTLP to the local stack (the app's resource labels, a separate instance). A single 3-second history load in an otherwise quiet window made A, the p95, 4.875 s, over the threshold. B, the loads, stayed "no data" (1 is below 5), and **History slow** stayed Normal for 4 minutes. With 7 slow loads in the window, B was 7, and the rule went pending and then fired a minute later.

**Rejected loads don't count (#208)**, the same day. At 17:39:31Z the local app received 4 history requests that FastAPI rejects with a 422 before the handler: a missing `tz`, a missing `view`, an unknown `view` and a malformed `date`. At 17:39:56Z a synthetic 3-second load was pushed as above. From 17:39:57Z to 17:44:27Z, A was 4.875 s. B, the loads that recorded a latency, was 1, so "no data". The old query over `focus_history_loads_total` read 5.06 and would have met the minimum. **History slow** stayed Normal throughout, and everything went back to no data once the loads left the 5-minute window.

### Apply the alert rules to Grafana Cloud

Grafana Cloud doesn't read the repo, and no agent has an editor login, so Yacine applies the rules once, and again after a PR changes them. `apply` creates or updates the environment's rule group through Grafana's alerting provisioning API, in the `I Need To Focus` folder (it creates the folder if it's missing). It keeps the rules editable in the UI, and it's idempotent, so a re-run overwrites with the repo's version.

1. In https://ineedtofocus.grafana.net, go to **Administration → Users and access → Service accounts → Add service account**. Name it `alert-rules-apply`, set the role to **Editor** and choose **Create**.
2. Choose **Add service account token**, name it `apply-<date>`, set **Expiration** to a day from now, choose **Generate token** and copy it.
3. From an up-to-date checkout of `main`, run `python3 scripts/grafana_alerts.py apply prod --grafana https://ineedtofocus.grafana.net` and paste the token at the prompt (it isn't echoed, stored or printed). Then run the same command with `dev`. `apply` refuses any `--grafana` URL that isn't `https://` (checked before it asks for the token), and never follows a redirect, which would carry the token elsewhere: use the stack's own URL.
4. Delete the token (or let it expire). The service account can stay for the next apply.
5. Check: **Alerting → Alert rules** lists **I Need To Focus → key-journey-prod** and **key-journey-dev**, two rules each, with state **Normal** and no error. Choose a rule's **View** to see its queries return a value.

If the stack's Prometheus data source isn't `grafanacloud-prom`, `apply` uses its one `grafanacloud-*-prom` data source, or asks for `--datasource <uid>` (shown in **Connections → Data sources**, in the data source's URL).

Once the routing is applied ([Alert routing](#alert-routing-34), below), a prod or dev alert, firing or resolved, wakes the on-call workflow. Until then, a firing alert follows the stack's default notification policy (**Alerting → Notification policies**), so it may notify no one; the rule's state in **Alert rules** is what to check.

## Alert routing (#34)

A firing or resolved alert in prod or dev wakes the on-call workflow:

```text
Grafana Cloud alert rule (#33; labels service, environment, alert)
  -> notification policy: service=ineedtofocus, environment=~prod|dev
  -> contact point focus-oncall-github (webhook, custom payload, Authorization: Bearer <token>)
  -> POST https://api.github.com/repos/ybenzine/ineedtofocus/dispatches
  -> repository_dispatch event, type grafana-alert
  -> .github/workflows/oncall.yml (#34: checks and logs the payload; #35: the on-call agent)
  -> incident issue, then a rollback, a fix PR or an escalation (below)
```

### Decision: Grafana calls GitHub directly, no relay

Grafana's webhook contact point (Grafana 12 and later, so Grafana Cloud and the local grafana/otel-lgtm 13) can do everything GitHub's dispatch endpoint needs:

- **Authorization header:** the `authorization_scheme` (`Bearer`) and `authorization_credentials` settings. The credentials are a secure field: Grafana stores them encrypted and reads them back as `[REDACTED]`.
- **Body:** a custom payload template (`payload.template`), a Go template rendered for each notification. Its `coll.Dict` and `data.ToJSON` functions build the JSON, so every value is escaped, an annotation's quotes and apostrophes included.
- **Headers:** `Accept: application/vnd.github+json` and `X-GitHub-Api-Version` as extra headers. Grafana adds `Content-Type: application/json` and `User-Agent: Grafana`, which GitHub requires.

So nothing of ours sits between Grafana and GitHub: no relay to host, secure, monitor or keep up while prod is down. A relay wouldn't make the GitHub token any less powerful either. It would need the same kind of token, kept in a server `.env` file instead of Grafana Cloud, and would add a public endpoint of its own. Checked on the local Grafana 13.2: the payload template, the stored token and the extra headers, both with a real alert and through the contact point test ([below](#proof-on-the-local-stack-34)).

### The token

The token is a **fine-grained personal access token** of `ybenzine`, limited to this repository. It has **Contents: Read and write** and nothing else; GitHub adds Metadata read-only by itself. It lives **only** in the Grafana Cloud contact point. It's never in git, in GitHub secrets or variables, or in a server `.env` file. Yacine creates it and enters it at `apply`'s hidden prompt ([below](#set-up-in-grafana-cloud-yacine)). It expires after 90 days; to rotate it, create a new one and run `apply cloud` again.

- **Why Contents write:** it's the only permission GitHub's `POST /repos/{owner}/{repo}/dispatches` accepts. Actions write would only allow a `workflow_dispatch`, and it would also let the token start, cancel and re-run any workflow, `rollback` included. A GitHub App token would have the same Contents permission and expire after an hour, and Grafana can't renew it.
- **Why it can't approve or start a deploy, though it's Yacine's:** a fine-grained token can do only what its permissions allow, whoever owns it. This one has no **Deployments**, **Actions**, **Administration**, **Environments** or **Workflows** permission. So it can't approve a pending deployment (Deployments write), start `deploy-prod` or `rollback` (Actions write), edit an environment or its reviewers (Administration), or change a workflow file (Workflows). The separation from #127 holds: no credential an agent can reach approves a deploy, and this one is never available to agents. A dispatch only starts `oncall.yml`; `scripts/tests/test_ci_workflow.py` checks that `deploy-prod` starts only by hand.
- **What a leaked token could do:** push to branches other than `main`, and delete or move unprotected branches and tags. It could create releases, and send dispatches, which wake on-call (#35's agent) with a payload that still has to pass the check below. It could **merge a pull request that is already approved and green**, because GitHub's merge endpoint needs only Contents write. It can't open a pull request, and a branch push starts no CI (CI runs on pull requests and on pushes to `main`). It **can't** change `main` any other way: branch protection requires the CI checks and an approval of the latest push, for administrators too ([process.md](process.md#4-review)). To stop it, revoke the token in GitHub (**Settings → Developer settings → Fine-grained tokens**).
- **Runs show `ybenzine`:** a dispatch made with the token shows `ybenzine` as the run's actor and as the event's `sender` (in the job summary), not Grafana. A run named after an alert that has no matching Grafana alert (**Alerting → Alert rules**, state history) means someone else used the token.
- **Grafana Editors can get it:** anyone who can edit contact points in Grafana Cloud (Editor or Admin) can point `focus-oncall-github` at their own URL, and Grafana will send them the stored token. Keep Editor and Admin in the stack to Yacine. Service account tokens for `apply` are Editor and expire within a day (step B on #34). #35's `GRAFANA_READONLY_TOKEN` must stay **Viewer**: a Viewer can't change contact points, and reads the stored token back only as `[REDACTED]`.
- **Authenticated only:** GitHub accepts a dispatch only with a token that can write to the repo. Grafana's token is one. The other is the agent account's, and `.claude/settings.json` denies `gh api …dispatches…` to agents. So an unauthenticated caller can't start the workflow, and there's no public endpoint of ours to attack. The `oncall` workflow still treats the payload as untrusted. It reads it from `$GITHUB_EVENT_PATH`, never through `${{ }}` in a script, checks it against the contract below and fails red otherwise. The job summary names the sender.

### The notification policy and contact point

`scripts/alert_routing.py` generates both, like the dashboards and the alert rules. The committed `infra/grafana/routing/oncall-github.json` is what `apply cloud` sends, minus the token. `make test-scripts` fails when that file and the script disagree.

| Setting | Value | Why |
|---|---|---|
| Matchers | `service=ineedtofocus`, `environment=~prod\|dev` | The labels #33's rules carry. A local rule never reaches Grafana Cloud anyway |
| Group by | `alertname`, `alert`, `environment` | One notification is one alert in one environment, so one dispatch is one incident |
| Group wait / interval | 10 s / 1 min | The rule's 1-minute pending period already debounces. A resolved notification follows within a minute |
| Repeat interval | 4 h | A still-firing alert is sent again every 4 hours. #35 updates the open incident rather than opening another |
| Resolved messages | sent | #35 confirms that the alert resolves |
| Position | first child of the root policy, `continue: false` | `apply` replaces only its own route and leaves every other policy as it was |

### The payload (contract for #35)

Event type **`grafana-alert`**; `client_payload` (`scripts/alert_dispatch.py` is the reference and the check):

| Field | Example | From |
|---|---|---|
| `alert` | `session-save-errors` or `history-latency` | the rule's `alert` label; the runbook is `_docs/runbooks/<alert>.md` |
| `environment` | `prod` or `dev` | the rule's `environment` label |
| `status` | `firing` or `resolved` | Grafana |
| `title` | `Session saves failing (prod)` | the rule's title (`alertname`) |
| `summary`, `description` | `Over 5% of session saves are failing in prod`; `19.67% of the 65 sessions submitted …` | the rule's annotations (aggregates only) |
| `started_at` | `2026-10-25T08:37:51Z` | when the alert started firing, UTC |
| `resolved_at` | empty while firing, then `2026-10-25T08:43:46Z` | UTC |
| `links.dashboard` | `https://ineedtofocus.grafana.net/d/focus-key-journey-prod?orgId=1&from=…&to=…` | the environment's key-journey dashboard, from 30 minutes before the alert to now (or to 10 minutes after it resolved) |
| `links.traces` | `https://ineedtofocus.grafana.net/explore?…` | Tempo, same time range: failed save requests (`status=error` on the save routes) or history loads over 1 s |
| `links.runbook` | `https://github.com/ybenzine/ineedtofocus/blob/main/_docs/runbooks/session-save-errors.md` | `_docs/runbooks/<alert>.md` once that file is on `main`. Until then (#35 writes both runbooks) it's the runbooks index, `_docs/runbooks/README.md`, so the link never points at a missing file. The rules' `runbook_url` annotation (#33) names the runbook ahead of time, so the template doesn't copy it |
| `links.alert` | `https://ineedtofocus.grafana.net/alerting/grafana/focus-session-save-errors-prod/view?orgId=1` | the rule in Grafana; a contact point test, which has no rule, links the alert list instead |

**No customer data:** the template copies only these named labels and annotations, never all of them, and the rules' labels and annotations hold only fixed words and aggregate numbers. The check refuses a missing or unexpected field, an environment other than prod or dev, a link outside `https://ineedtofocus.grafana.net/` or this repo's runbooks, and any text holding an email address or a YouTube link. GitHub allows at most 10 top-level `client_payload` fields; this has 9.

**Free text an agent reads:** #35 hands the payload to an agent, so whoever sends a dispatch must not be able to write instructions into it. Every text field (`title`, `summary` and `description`) is pinned to #33's rules for that alert and environment. `alert_dispatch.py` reads them from `grafana_alerts.rules()` rather than keeping a copy, so a rule edit moves the check with it (#212).

- `title` and `summary` must be exactly the rule's title and summary. Both are fixed text.
- `description` must match a pattern built from the rule's description template. The literal prose must be exact, and each `{{ … }}` slot may hold only what its function renders: a percentage (`humanizePercentage`, e.g. `30.95%`), a whole number (`printf "%.0f"`, e.g. `87`) or a duration (`humanizeDuration`, e.g. `4.875s` or `2m 3s`). A slot with any other function fails the tests until `SLOT_VALUES` gives it a pattern, so a new kind of slot can't let free text through.
- The slot patterns are exactly the shapes Prometheus' template functions print, which Grafana uses. They accept ASCII digits only, so `٣٠%` or `３０%` fails. A percentage has Go's `%.4g` shape (at most 4 significant digits), and a whole number has 1 to 15 digits, so a slot can't spell out text in digits. A duration is only one of `humanizeDuration`'s forms: `1d 2h 3m 4s`, `2h 0m 5s` or `3m 4s` with hours under 24 and minutes and seconds under 60, `4.875s`, `0s`, or a sub-second form such as `500ms`. Tests check every value the functions can print against the patterns, over values from 1e-24 to 1e8.
- **The check fails closed.** If an allowed alert and environment has no rule in `grafana_alerts.py`, the dispatch is refused with "no rule for …" rather than passed unchecked. If Grafana ever renders a slot in a form the pattern rejects (a future Grafana changing `humanizeDuration`, say), the dispatch fails `check-event` and the `oncall` run goes red. Nothing reaches the agent, and the alert is still in Grafana. #35's runbook should say so: on a red `oncall` run whose error is "description is not the rule's template", compare the rendered value with `SLOT_VALUES` and widen the pattern to the new form only.
- On top of that, none of the three may hold a link (`http://`, `https://`, `www.` or a Markdown link); links go only in `links`, which is checked.

The synthetic alerts that `verify` renders and `test` sends carry the rule's description with `0` in every slot (`0% of the 0 sessions submitted …`), so they pass the same check and say nothing failed. A contact point test is told apart by `links.alert`, which links the alert list rather than a rule. `scripts/tests/test_alert_dispatch.py` checks that every real dispatch passes (both alerts, prod and dev, firing and resolved) and that injection attempts fail `check-event` (`test_a_description_other_than_the_rules_fails_check_event`, `test_a_prompt_injection_fails_check_event`). Pinning limits what a sender can say, not whether the numbers are true: #35's prompt still presents every payload field as untrusted data and reads the real values from Grafana.

**For #35 (done):** `python3 scripts/alert_dispatch.py check-event "$GITHUB_EVENT_PATH"` is still the workflow's first job, `alert`, with no secret and no environment. The agent jobs come after it, in the `oncall` environment ([On-call agent](#on-call-agent-35)). A `repository_dispatch` always runs on the default branch, `main`, which the environment's branch rule allows. No payload value appears in `${{ }}` inside a `run:` script; `scripts/tests/test_alert_routing.py` and `scripts/tests/test_oncall_workflow.py` check both. #35 added the runbooks `_docs/runbooks/session-save-errors.md` and `history-latency.md` and regenerated `infra/grafana/routing/oncall-github.json`, so after the merge `apply cloud` has to run again, a human step, for the dispatches to link the runbooks. Until then they keep linking the index, which the check still accepts.

### Proof on the local stack (#34)

`make check-stack` (in CI too) has the local Grafana render the payload template for both alerts, prod and dev, firing, resolved and a contact point test. Every result must pass the workflow's check (`python3 scripts/alert_routing.py verify`).

**The full loop locally**, with a stand-in for GitHub's endpoint. It requires the bearer token, validates every dispatch the way the workflow does and answers 204, or 401, 404 or 422 like GitHub. It needs Docker Desktop, whose `host.docker.internal` lets the Grafana container reach the host, and #33's rules and fault injection:

1. `python3 scripts/alert_dispatch.py receive --out /tmp/dispatches.jsonl`. It prints a throwaway stand-in token.
2. `python3 scripts/alert_routing.py apply local --grafana http://127.0.0.1:<GRAFANA_PORT>`, and paste the stand-in token. This adds the same contact point to the local Grafana, posting to the stand-in, with a route for `environment=local`. Blank keeps the stored token on later runs.
3. `python3 scripts/alert_routing.py test local --env local --alert history-latency --grafana http://127.0.0.1:<GRAFANA_PORT>` sends a contact point test, in the namespace the local Grafana names (`default`; see [The receivers API's namespace](#set-up-in-grafana-cloud-yacine)). The stand-in prints `204   history-latency firing in local`.
4. Fire and resolve **Session saves failing** with fault injection and `scripts/traffic.py` ([#33](#alerts-user-impact-not-resources)). The stand-in prints one line per dispatch.

On 2026-10-25, on the local stack with #33's rules, `FAULT_SAVE_ERROR_PERCENT=30` from 17:07:50Z and off again at 17:11:11Z, with `traffic.py --rate 30` running:

```text
17:09:21Z  session-save-errors: pending
17:10:21Z  session-save-errors: firing
204   session-save-errors firing in local (started 2026-10-25T17:10:10Z, resolved -)
17:15:22Z  session-save-errors: normal
204   session-save-errors resolved in local (started 2026-10-25T17:10:10Z, resolved 2026-10-25T17:15:10Z)
```

Both dispatches arrived with `Authorization: Bearer <stand-in token>`, `Accept: application/vnd.github+json`, `Content-Type: application/json` and `User-Agent: Grafana`. Both passed the check, with the description `30.95% of the 87 sessions submitted in the last 5 minutes failed (outcome="error"); … Users' sessions stay queued …`. The traces link's query found the 19 failed save requests in Tempo. A request without the token gets 401 (covered by `scripts/tests/test_alert_dispatch.py`).

**A resolution with no data (#212)**, the same day. Fault injection stayed on and the traffic stopped at 18:26:51Z, so the rule could resolve only through "no data". It fired at 18:24:20Z with `20.47% of the 99 sessions submitted …`. It resolved at 18:32:20Z as **Normal (NoData)**, and the resolved dispatch carried the description of the last evaluation that had data, `30% of the 21 sessions submitted …`. Both dispatches pass the pinned check, so a no-data resolution has the same shape as any other.

### Set up in Grafana Cloud (Yacine)

Do this once, after the PR that adds `.github/workflows/oncall.yml` is merged: a dispatch only starts workflows that are on `main`. The exact steps are on [#34](https://github.com/ybenzine/ineedtofocus/issues/34):

1. Create the fine-grained token ([above](#the-token)). Then check that its page lists only **Contents: Read and write** and **Metadata: Read-only**. With any other permission, the analysis above no longer holds.
2. Create a Grafana service account token (Editor, one day), as for the alert rules.
3. `python3 scripts/alert_routing.py apply cloud --grafana https://ineedtofocus.grafana.net`, pasting the Grafana token and then the GitHub token at the hidden prompts. A re-run updates both in place. A blank GitHub token keeps the stored one, which `apply` only ever sends back as `[REDACTED]`.
4. `python3 scripts/alert_routing.py test cloud --env dev --alert session-save-errors --grafana https://ineedtofocus.grafana.net`, then check that **Actions → oncall** shows a green run named **Alert: session-save-errors firing in dev**.

**The receivers API's namespace (#219).** `test` uses Grafana's receivers API, `/apis/notifications.alerting.grafana.app/v1beta1/namespaces/<namespace>/…`. The namespace is `default` for org 1 of an OSS Grafana, like the local stack, and `stacks-<stack id>` in Grafana Cloud, where `default` gets `HTTP 403 … "invalid namespace"`. So `test` first reads `namespace` from `GET /api/frontend/settings`, with the same token and the same https-only, no-redirect request as every other call. That's the value Grafana sets for its own UI (`frontendSettings.Namespace = hs.namespacer(c.OrgID)` in Grafana's `pkg/api/bootdata.go`). The success line names it: `ok    sent a synthetic … through focus-oncall-github (stacks-<id>)`. If the settings name no namespace, `test` says so and uses `default`. `--namespace <namespace>` skips the lookup. It only accepts a valid Kubernetes namespace (lowercase letters, digits and `-`), so the value can't add a path segment or a query. `apply` and `verify` don't use the `/apis/…` API, so no namespace is involved there. On 2026-10-25, on the local Grafana 13.2.3, the lookup returned `default` and both alerts' tests reached the stand-in (`204`). Forcing `--namespace stacks-123` there got the same `403 … "invalid namespace"` that Grafana Cloud gave for `default`. `scripts/tests/test_alert_routing.py` covers a Cloud-style `stacks-123`, the fallback, the flag, and checks that the token only goes to the `--grafana` host.

The contact point and policy stay editable in the Grafana UI, but the next `apply` overwrites them, so make changes in the script.

### Droplet disk alert (DigitalOcean, #202)

One alert watches a resource: the Droplet's disk. It's a DigitalOcean Monitoring alert policy, configured by Yacine in the DigitalOcean console (**Monitoring**, under its resource alert policies), not in this repo:

| Policy | Metric | Fires when | Resource | Notifies |
|---|---|---|---|---|
| `ineedtofocus disk > 80%` | `do.droplets.disk_utilization` (Disk Utilization) | Above 80% for 10 minutes (critical) | The Droplet, `flocus-s-1vcpu-2gb-nyc1` | Yacine, by email |

**Why this one exception to user-impact-only alerting.** Prod and dev share one disk, and a full disk breaks both at once: Postgres stops accepting writes, and a `releases.log` line cut short stops every deploy and rollback that reads it ([deployment.md → The release record](deployment.md#the-release-record)). The session-save alert would fire only once the disk is already full, so it gives no lead time. At 80% there's time to clean up before any user notices. The policy is free and needs nothing on the server but the DigitalOcean metrics agent. Without the agent, the Droplet's **Insights** tab still shows CPU and bandwidth; the agent adds the disk and memory graphs, and the disk metric this policy reads. `bootstrap.sh` doesn't install that agent, so after a rebuild check that the disk graph shows data again; without it, the policy has nothing to evaluate. CPU and memory stay unalerted: memory is bounded per container, and the user-impact alerts already catch what they would cause.

**Not connected to anything else.** It notifies by email only: no Slack, no webhook, no Grafana contact point, and it never reaches the on-call agent (#35). A rollback can't free disk, and the fix needs a person on the server. Nothing in Grafana watches the disk either: no Grafana rule, and no `hostmetrics` receiver in the collectors, which stay per-environment and read only their app's telemetry ([#117](deployment.md#host-resources-processes-privileges-disk-117)'s isolation). `scripts/tests/test_grafana_alerts.py` still fails if a Grafana rule queries anything but the journey metrics.

**When it fires** (Yacine, on the server):

1. **How full, and where.** `df -h /` shows the root filesystem's use; it's the one disk, holding Docker's data (`/var/lib/docker`) too. `docker system df -v` splits Docker's share into images, containers, local volumes and build cache, with each volume's size. For what's outside Docker: `sudo du -xh --max-depth=2 / 2>/dev/null | sort -h | tail -20`.
2. **What usually fills it**, in the order to check it:
   - **The Postgres volumes**, `focus-prod_db-data` and `focus-dev_db-data` (their sizes are in `docker system df -v`). They're the one thing that grows by design. Dev's grows with every `scripts/traffic.py` run, whose throwaway accounts and sessions nothing cleans up ([Traffic script](#traffic-script)). Prod's data is real users': never delete it to free space. If prod's volume itself is what's large, resizing the Droplet or adding a volume is a cost decision for Yacine.
   - **Old images.** Every deploy and rollback prunes the app images neither environment may start again ([deployment.md → Old images: pruning (#117)](deployment.md#old-images-pruning-117)). If `docker image ls ghcr.io/ybenzine/ineedtofocus` lists many more than both environments' windows, pruning is skipping: look for `not pruning old images` in `journalctl -t focus-ci`, and check that the installed `focus-ci` is current (`install.sh`). Never run `docker image prune -a` or `docker system prune -a`: they remove the pinned dependency images, and a rollback would then depend on Docker Hub. Images are built in CI, never on the server, so the build cache should be empty.
   - **Container logs.** Docker rotates each container's log at 3 × 10 MB (`/etc/docker/daemon.json`, set by `bootstrap.sh`), so these stay small unless that file was changed or a container predates it. Check `sudo du -sh /var/lib/docker/containers`. The system journal grows too: `journalctl --disk-usage`, and `sudo journalctl --vacuum-size=200M` trims it. Trimming deletes the oldest entries of every unit, `focus-ci`'s deploy, rollback and pruning history included, so read `journalctl -t focus-ci` (the old-images check above) before you trim, and trim only if the journal is what's large.
   - **apt caches and old kernels**, from unattended upgrades: `sudo du -sh /var/cache/apt`, then `sudo apt-get clean` and `sudo apt-get autoremove`.
   - **A manual mistake**: a dump, a copied image or a log left in a home directory or `/tmp`. The `du` above finds it.
3. **Resolved** once use is back below 80%. If the disk filled before anyone acted, a `releases.log` line may have been cut short: deployment.md's [release record](deployment.md#the-release-record) says how to find and move it out.

## On-call agent (#35)

`.github/workflows/oncall.yml` runs Claude Code headless when a dispatch arrives. There's one run per alert and environment at a time, never cancelled, so a resolved event waits for its firing run. GitHub keeps one waiting run per group, so a newer dispatch replaces one that's still waiting. **No Claude session holds a token that can write.** Sessions leave files, and deterministic jobs check them and do every write. The jobs, and what each may do, are in [deployment.md → On-call workflow](deployment.md#on-call-workflow-35).

```text
alert        check-event (no secrets)
incident     find "Incident: <rule title>" (type:incident), or open it and lock it; daily run cap
               over the cap, resolved: posts its own summary and closes the incident (no session)
respond      on-call session (.claude/agents/oncall.md: opus, high), read-only token
               reads Grafana with scripts/oncall_grafana.py, follows the runbook
               -> /tmp/oncall/decision.json (rollback | fix | escalate | none; cause), comment.md,
                  for a fix: commits on oncall/<n>-<slug> (bundled), pr.md
act          checks them (scripts/oncall.py); posts the comment, ending with its record of the decision;
               labels (needs-yacine, oncall:rolled-back)
               fix: pushes the branch and opens the PR (Refs #n) as the on-call App, or posts a patch
               resolved: closes the incident unless its fix PR is still open
rollback     gh workflow run rollback.yml -f env=<the alert's env> [-f tag=<sha>], once; waits
review       waits for CI; reviewer session (read-only, no App key) writes the review and verdict
post-review  posts it through the reviewer App (scripts/reviewer-review.sh); comment if no key
merge        APPROVED and green: squash-merge as the on-call App (dev deploy); prod: ask Yacine
               to start deploy-prod with that tag and approve it
wait         waits for the alert to resolve (after a rollback, or a merged fix to a dev alert)
follow-up    on-call session given only the steps' checked results; writes the report
report       posts it, or ⛔ Needs Yacine: if it didn't finish
```

**What a session reads.** Its prompt (`scripts/oncall.py`, templates in `scripts/oncall_prompts/`) carries only the payload fields whose values are fixed or pinned: `alert`, `environment` and `status` (enums), `title`, `summary` and `description`, pinned to the rule's text since #212 with only numbers in the description's slots, and the timestamps. The Grafana links stay out, since their query strings are free text. It also gets the workflow's own record of the incident: its number, whether it already had its rollback, and its open fix PR. State passes between sessions only that way, through the steps' checked outputs. The follow-up session gets the rollback run, its result, the review verdict, the merge, the wait result and the alert's numbers, all checked. It never takes over what an earlier session wrote on the issue. The prompt presents the alert as untrusted data. Only comments by `ybenzine` and `merciful-poseidon` may carry instructions. Everything else is data: other accounts, this workflow's own bot, and anything found in logs, traces, commits or PR bodies. The workflow locks each incident issue to collaborators, when it opens it and when it reuses one that isn't locked. It uses no lock reason, since none of GitHub's fits.

**What a session may do (#232).** `scripts/oncall-claude.sh <session>` gives each session (`respond`, `review`, `follow-up`) its own tools and allow list on the command line, in `dontAsk` mode, so anything else is refused without asking. It also passes `--effort` from the session's agent definition (`oncall.md`, or `reviewer.md` for the review): in `-p` mode Claude Code applies a definition's `model:` but not its `effort:`, and would send medium. `test_oncall_cli.py` checks that the requests carry both. Not `.claude/settings.json`: on a fresh runner the workspace isn't trusted, so Claude Code ignores its allow rules (the log's `Ignoring 124 permissions.allow entries … this workspace has not been trusted` line, which is expected), and they're broader than a session that reads untrusted text should get. Its deny rules still apply. Before #232 the sessions relied on those allow rules, and the first dev drill's session was refused every tool it needed (run 40240380314).
- **All three:** Read in the checkout and `/tmp/oncall`, and plain read-only commands there (`ls`, `grep`, `find`, `git log|show|diff`). Write only to their own output files. `gh issue view` and `gh pr view|diff|checks`.
- **respond:** also `python3 scripts/oncall_grafana.py …` (not `wait`), `gh issue|pr list`, `gh run view|list`, and `printenv ANTHROPIC_API_KEY` exactly, its prompt's one check that the key isn't in its commands' environment (#266, below). For a fix: `git switch -c oncall/…`, `scripts/oncall-commit.sh` (below), the `make` test and lint targets for the backend, scripts and frontend, exactly, and Write and Edit under `backend/`, `frontend/`, `scripts/`, `infra/` and `_docs/`, except the files `check-fix` refuses.
- **follow-up:** `oncall_grafana.py` (not `wait`) and `gh run view|list`; writes `comment.md` only.
- **review:** writes `review.md` and `review.json` only; no `make`, no checkout. It runs `oncall-reviewer`, which `scripts/oncall.py reviewer-agent` builds from `.claude/agents/reviewer.md` plus Write and passes with `--agents`: the reviewer people run has no Write or Edit tool and stays read-only (tested), and without Write the headless review could never leave its files.
- **Never:** `$(…)`, secret variables (`$ANTHROPIC_API_KEY`, `$GRAFANA_READONLY_TOKEN`, `$GH_TOKEN`), environment prefixes (`GRAFANA_URL=… python3 …`, `MAKEFLAGS=… make …`), `git add` and `git commit` themselves, Read outside those directories, a write anywhere else (Bash writes, a redirect say, only where the session's Write rules allow, so to its own output files), `gh api`, `gh workflow`, `git push`, posting, any other Python.
- **Commits go only through `scripts/oncall-commit.sh "<message>" <file>…`.** Claude Code's rules match a command's text, so a deny rule is a second, best-effort layer: a quoted option (`git add --path''spec-from-file=/proc/self/environ`, `git commit -m x '--pathspec-from-file=…'`) gets past one, and git then prints the file it read, the session's keys included, in an error. The script checks its arguments after the shell has parsed them (`scripts/oncall.py commit-check`): the message is one argument, 1 to 500 characters, not `-…`, with no control character, closing keyword or token-shaped text. Each file is a plain path, not `-…`, inside the checkout through any symlink, not in `.git`, not a directory, and not a path `check-fix` refuses. Then git runs with a clean environment (`env -i`: no caller `GIT_*` and no keys; no system or global config; literal pathspecs) and no hooks: `git add -- <files>`, `git commit --no-verify -m <message>`. The script is protected like the wrapper. As a backstop, `check-fix` refuses a branch whose commit messages or added lines hold token-shaped text (`sk-ant-`, `glsa_`, `ghs_`, `-----BEGIN`…).
- **The other allowed commands take no option that reads a file** (checked for #232): the `make` targets are exact rules, so no argument or prefix can be added (the CLI refuses `make test-scripts -f …` and `MAKEFLAGS=… make …`). `gh issue|pr view|list`, `gh pr diff|checks` and `gh run view|list` read only GitHub (`--template` and `--jq` take strings, not files). `git switch -c oncall/…` has no such option, and `oncall_grafana.py` takes only its subcommands, numbers and query strings (no argparse file arguments; `GRAFANA_URL=…` as a prefix is refused). The plain read-only commands are refused as soon as a path outside the checkout appears, quoted or as an option value (`grep -f`, `--file=`, `git diff --no-index`, `git -C`, `sort --files0-from`…). The one exception is `git log -- /etc/hosts`, which is harmless: git refuses a pathspec outside the repository and reads nothing.

- **No secret in its commands' environment (#266).** Every session step sets `CLAUDE_CODE_SUBPROCESS_ENV_SCRUB=1`, and `scripts/oncall-claude.sh` won't start a session without it. The pinned Claude Code then starts each command a session runs (`make`, `python3`, `gh`…) without `ANTHROPIC_API_KEY`, `GRAFANA_READONLY_TOKEN` or any other variable whose name looks like a secret; it keeps `GH_TOKEN`, the read-only workflow token, so `gh` works. It also prints `Permission mode forced to default — CLAUDE_CODE_SUBPROCESS_ENV_SCRUB is set`, which is expected: in `-p` mode the default mode refuses whatever the allow list doesn't cover, as `dontAsk` does. The respond session runs `printenv ANTHROPIC_API_KEY` once (it prints nothing and exits 1) and ends its comment with `Subprocess check: printenv ANTHROPIC_API_KEY printed nothing (exit 1).`. If it ever printed the key, the prompt says never to copy it, and the workflow refuses a `comment.md` with token-shaped text. What the commands can still read is in [deployment.md → On-call workflow](deployment.md#on-call-workflow-35).

`scripts/tests/test_oncall_cli.py` checks the wrapper's command line for each session, and runs the pinned Claude Code on a fresh, untrusted checkout against a fake Messages API that asks for one tool call per turn, then reads what the CLI allowed and refused from its result, and what the allowed `make`, `gh` and Grafana commands found in their environment (#266). No API key, no cost. CI installs the pinned CLI for it, so it can't skip there.

**Reading Grafana: `scripts/oncall_grafana.py`.** GET only, with the Viewer token as a bearer token, over https only, never through a redirect, and never printed. The token comes from `GRAFANA_READONLY_TOKEN` (a person, the `wait` step) or, in an on-call session, where the scrub strips that variable, from the file `token` in `ONCALL_GRAFANA_DIR` (#266). The respond and follow-up jobs write it under `$RUNNER_TEMP`, mode 600, just before the session and remove it right after, whatever happened. The script refuses a file that's missing, a link, someone else's, wider than 0600 or inside the checkout or `$GITHUB_WORKSPACE`, and exits non-zero saying which.
- `journey`, `alerts` and `wait <alert> <env> normal|firing` cover the alert. `wait` runs as a workflow step, not in a session, since the Bash tool's timeout is shorter than a wait.
- `errors`, `failed` and `slow` give error logs, failed requests and slow requests, and `trace <id>` shows one trace's spans with a few allowlisted attributes.
- `prom`, `logs` and `traces` run any query.
- A log line's body prints as a quoted string under a header that calls it untrusted data, since it can carry request-derived text. Each line is cut at 400 characters.
- Against the local stack it needs no token: `GRAFANA_URL=http://127.0.0.1:<GRAFANA_PORT>`. The token must stay **Viewer** ([above](#the-token)).

**The incident's life.** A firing alert updates the newest open incident with its exact title, or opens one. A repeat (every 4 hours while it fires) updates the same issue: a fix PR says `Refs #<n>`, never `Closes`, so the merge to dev doesn't close it. A resolution looks in any state, for an issue still open or closed after the alert started, and never opens one. Its session writes the incident summary (timeline, cause, action, verification, follow-ups). The workflow posts it and closes the issue, unless the incident's fix PR is still open. Over the daily cap (below), a resolution still closes the incident the same way, with no session (#312): the `incident` job writes the summary itself (`scripts/oncall.py capped-summary`) from the alert, the environment, the firing start and resolved times, links to the incident's on-call runs, and the action and cause of the last decision the workflow recorded on the incident, or "not analysed by the agent: daily cap reached" if there's none. That record is the last line of the comment the `act` job posts for a checked decision, an HTML comment `<!-- oncall:decision {"action": …, "cause": …, "run": …} -->`. The cause is `decision.json`'s optional `cause`, cut to one line of at most 200 characters with only letters, digits, spaces and `_ . , ; : ( ) ' / % + = -`, so no `@` mention, `#n` reference, Markdown link, HTML or backtick. A bare URL (`https://…`, `www.…`) or `GH-<n>` still fits, and GitHub autolinks those in prose, so the summary shows the cause as inline code, where GitHub links nothing (and with no backtick, the cause can't close the span). Only comments by `github-actions[bot]` count, only when the record is their last line, and the record is checked again when read. A session's `comment.md` or report that holds `<!-- oncall:` is refused, so a session can't forge one. Adding a label takes triage access, so an outsider's issue with the same title can't take an incident's place.

**When it can't finish.** Every session has a turn cap, a dollar cap and a step timeout below its job's, so a cap fails the step instead of cancelling the job. The jobs after it run `always()`: `act` after the on-call session, `post-review` and `merge` after the reviewer, `report` after the follow-up. If a session's files are missing or don't pass the check, nothing happens: no rollback, PR, review or merge. The workflow posts `⛔ Needs Yacine:` on the incident with the reason and the run's link, and adds the `needs-yacine` label. After each session, `scripts/oncall.py session-summary` reads Claude Code's result (`--output-format json`) into the step summary and a one-line job output: its subtype (`success`, `error_max_turns`, `error_max_budget_usd`…), turns, cost, and the refused tool calls with counts (#232). The `⛔ Needs Yacine:` for a respond, review or follow-up session that left nothing usable carries that line, checked again in the job that posts it. A refused call is named by its tool and, for Bash, the command's first word and at most one subcommand-like word, each a plain lowercase word (`Bash(gh run)`, `Bash(python3)`), or for a file tool the file's name only when it's one of the sessions' own output files (`Write(decision.json)`). Nothing else from its input: a path, a URL, a token or a file name can carry Grafana or GitHub text, a key or a user's goal. The transcript stays on the runner.

**The daily cap.** The `incident` job counts this workflow's earlier runs for the same alert and environment in the last 24 hours in which the on-call agent session started (#312). It reads each run's jobs (`gh run view <id> --json jobs`) and counts the run when the `On-call agent` job's `Run the on-call agent` step ran, failed or was cancelled. A run with no session doesn't count: a capped run, a skipped one (a resolution with no incident) or one with no agent job, like #34's stub run. A run whose jobs can't be read counts, since the cap bounds cost. With 4 such runs, a firing or repeat starts no session and posts `⛔ Needs Yacine:` once in the window (a later capped run sees the earlier one's `Post the daily cap` step). A resolution needs no paid session, so it's never blocked: over the cap it gets the workflow's own summary and closes the incident, as above. A capped run never rolls back, reviews, merges or opens a fix PR: the jobs that do follow the session, which doesn't run. The Anthropic spend limit stays the backstop.

**Proof without Grafana Cloud.** `scripts/tests/test_oncall_workflow.py` runs the workflow's own steps with `scripts/tests/oncall_sim.py`. It takes the `needs`, the `if:` conditions and the `env:` and `outputs:` mappings from the YAML, with fake `gh`, `claude` and `uv` and real git against a throwaway origin. It covers:
- a prod rollback, started once;
- a second rollback for the same incident, refused by the label;
- a second alert's rollback, skipped as recent;
- a dev fix pushed and opened by the on-call App, reviewed through the reviewer App and merged by the on-call App, with no session holding a write token or an App key;
- a prod fix's deploy ask;
- the comment fallback without the reviewer key, ending in `⛔ Needs Yacine:`;
- the patch fallback without the on-call key;
- a fix that touches the guardrails, refused;
- resolutions that close, keep or skip the incident;
- the daily cap: counting only runs whose session started (not #34's stub run, a capped or a skipped run), its `⛔ Needs Yacine:` once, and a resolution over the cap that still closes the incident with the workflow's summary, or keeps it open while its fix PR is (#312);
- sessions that don't finish, with Claude Code's result in the `⛔ Needs Yacine:`.

The sim's `claude` is fake, so it can't show what the real CLI allows on a fresh runner: `scripts/tests/test_oncall_cli.py` does ([above](#on-call-agent-35)).

`scripts/oncall_grafana.py` ran against the local stack's Grafana on 2026-10-25, with `FAULT_SAVE_ERROR_PERCENT=30` and `traffic.py --rate 30`:
- `wait session-save-errors local firing` saw pending at 18:49:10Z and firing at 18:50:10Z.
- `journey local` read a `save_error_rate` of 0.339 over 62 sessions.
- `failed local` listed the failed saves. `trace <id>` on one showed `error.type` `app.faults.InjectedSaveFault` on `POST /api/sessions/sync` (500).
- `errors local` gave the `unhandled exception` lines with `exception_type=InjectedSaveFault` and their `trace_id`.
- Fault injection went off at 18:51:05Z, and `wait … normal` saw the alert resolve at 18:57:06Z, with the error rate back at 0.

The end-to-end drill on dev needs #33's rules and #34's contact point applied to Grafana Cloud first ([#35](https://github.com/ybenzine/ineedtofocus/issues/35)), and the server's installed infra at #33 or later: follow [Alert trigger](#alert-trigger-fault-injection) from its step 1, which checks `/opt/focus/infra/REVISION`, and confirm with `docker exec focus-dev-app-1 env | grep FAULT` before starting the traffic.

That first real drill on dev (incident [#231](https://github.com/ybenzine/ineedtofocus/issues/231), [firing run](https://github.com/ybenzine/ineedtofocus/actions/runs/40276987971), [resolved run](https://github.com/ybenzine/ineedtofocus/actions/runs/40278298276), [write-up on #35](https://github.com/ybenzine/ineedtofocus/issues/35#issuecomment-6409695167)) used fault injection, so the runbook's right answer was to escalate, and the agent escalated. The drill below is the one where the agent fixes the problem itself.

### On-call drill: rollback of a bad deploy (#317)

On 2026-10-26 a deliberately broken release reached dev. The real **Session saves failing (dev)** alert fired, and the on-call agent tied the failures to that deploy and rolled dev back through the `oncall` workflow, with no human acting on the incident. There was no fault injection and no simulated payload. The full evidence is on [#317](https://github.com/ybenzine/ineedtofocus/issues/317).

- **Releases:** `G` = `d6bc665` (dev before the drill), `B` = `3ceae88` (demo [#318](https://github.com/ybenzine/ineedtofocus/pull/318): both save endpoints raise `RuntimeError` when the app is labelled `deployment.environment.name=dev`), `R` = `34a1bf3` (revert [#321](https://github.com/ybenzine/ineedtofocus/pull/321), tree identical to `G`).
- **Runs:** CI for `B` [40341748427](https://github.com/ybenzine/ineedtofocus/actions/runs/40341748427) (deployed it to dev), firing on-call run [40343299665](https://github.com/ybenzine/ineedtofocus/actions/runs/40343299665), `rollback.yml` [40343637237](https://github.com/ybenzine/ineedtofocus/actions/runs/40343637237), resolved on-call run [40344593714](https://github.com/ybenzine/ineedtofocus/actions/runs/40344593714), CI for `R` [40347922616](https://github.com/ybenzine/ineedtofocus/actions/runs/40347922616) (green; its **Deploy to dev** deployed nothing, because dev already ran `3d65b12`, the README merge #320 just after `R`, which [40348807424](https://github.com/ybenzine/ineedtofocus/actions/runs/40348807424) had deployed). Incident: [#319](https://github.com/ybenzine/ineedtofocus/issues/319).

| UTC | Event |
|---|---|
| 14:40:05 | #318 merges (`B`) |
| 14:44:59–14:45:53 | **Deploy to dev** deploys `B`; rollback target in its record: `d6bc665` |
| 14:46:35 | `traffic.py --base-url https://dev.ineedtofoc.us --minutes 25 --rate 30` starts |
| 14:46:36 | First failed save trace (`17c612a8349edc04692f3b2058e7eb54`) |
| 14:49:30 | Alert fires |
| 14:49:44 | Firing on-call run starts; 14:50:05 incident #319 opens |
| 14:50:12–14:51:32 | On-call agent session |
| 14:51:41 | [Decision: roll back dev](https://github.com/ybenzine/ineedtofocus/issues/319#issuecomment-6419076929) |
| 14:51:52 | `rollback.yml` starts; 14:52:06 "rolling dev back from `3ceae882…` to `d6bc665c…`, no migration" |
| 14:52:36 | Rollback done, smoke checks ok (dev runs `G`) |
| 14:57:30 | Alert resolves |
| 14:59:23 | [Follow-up report](https://github.com/ybenzine/ineedtofocus/issues/319#issuecomment-6419264070) (from, to, verification) |
| 14:59:53–14:59:54 | Resolved run, over the daily cap, posts the workflow's [incident summary](https://github.com/ybenzine/ineedtofocus/issues/319#issuecomment-6419277737) (#312) and closes #319 |
| 15:10:32 | Revert #321 merges (`R`) |
| 15:28:38–15:29:20 | **Deploy to dev** deploys `3d65b12` (#320, on top of `R`), so dev runs `main` again, without the gate. `R`'s own CI run, which GitHub started late (15:17:49), then skips its deploy as older than what dev runs |

Alert to restored in about 3 minutes, alert to resolved in 8.

**The agent's evidence.** `journey dev` showed 116 of 116 sessions submitted in 5 minutes failing, history fine. Every failure was a 500 with `RuntimeError` raised in `fastapi.endpoint` before any write: error logs with trace IDs `6eb9179b3048735ed0468e8f1ca56c35`, `4beb0828debbb27eb4838762ce363295` and `230b9d73fcfc3525ffc9845a67b4e3aa`, and failed trace `1378029f127697884af454347590123c`, all from `service.version` `3ceae882df6bfb182a551ea0e4793b2a3adb9243`. It ruled out the database (healthy SQL spans) and fault injection (`RuntimeError`, not `InjectedSaveFault`), found `_broken_build_gate()` in #318's diff, and applied the runbook's first row ([session-save-errors.md](runbooks/session-save-errors.md)): errors started with a deploy, the previous release was fine, no migration, so roll back. Verification after the rollback: `save_error_rate` 0.0 over 98 sessions, both alerts normal, and saves and syncs returning `created` again.

**Traffic totals** (`traffic.py`, stopped at 14:56:11): single saves 54 ok and 73 failed, sync batches 15 ok and 28 failed, history loads 112 ok and 4 failed while the app container was recreated. The app's own client keeps a failed session in its offline queue and syncs it later (F13), but `traffic.py` has none: it counts a failed save or batch and drops it, and each later batch is new sessions. So no queue drained in this drill.

**Prod never ran `B`:** its last deploy ([40327763725](https://github.com/ybenzine/ineedtofocus/actions/runs/40327763725)) was at 13:06Z, before `B` existed, and `focus-ci prod` refuses a release dev rolled back from ([deployment.md → Known-good releases](deployment.md#known-good-releases)).

**What to know.** The agent's comments date #318's merge at 14:34; it merged at 14:40:05. Its follow-up report also reads the rise in `sync` `created` after the rollback as the offline queue draining; with `traffic.py` as the only client, those were new batches (above). With a read-only token it couldn't file its follow-ups, so it listed them on #319: fix forward (done by the revert #321), drill design (a deploy-triggered drill leaves `main` broken until it's reverted), and a guard against redeploying a commit dev rolled back from while it's still on `main`.

## Where to look

| Where | Grafana | Dashboard |
|---|---|---|
| Local (`make up`) | `grafana/otel-lgtm` at `http://localhost:<GRAFANA_PORT>` (3000 by default) | **I Need To Focus → I Need To Focus: key journey (local)**, provisioned by `compose.yaml` |
| Dev, prod | Grafana Cloud stack https://ineedtofocus.grafana.net | **I Need To Focus: key journey (dev)** / **(prod)**, imported from `infra/grafana/dashboards/` ([below](#dashboards-32)) |

## Grafana Cloud (#32)

| | |
|---|---|
| Stack | https://ineedtofocus.grafana.net |
| OTLP endpoint | `https://otlp-gateway-prod-us-east-3.grafana.net/otlp` |
| Instance ID (OTLP basic-auth user) | `1889715` |

### One collector per environment

Each Compose project (`focus-prod`, `focus-dev`) keeps its own OpenTelemetry Collector (`infra/otel-collector/`, [deployment.md](deployment.md#telemetry-to-grafana-cloud)). #32 settles this; a single shared collector was the alternative. Reasons:

- **Dev can't hurt prod's telemetry.** A burst from dev fills dev's batch queue and trips dev's `memory_limiter`, never prod's. Each collector has its own 96 MiB limit, and dev's has `oom_score_adj: 500` like the rest of dev ([deployment.md](deployment.md#memory-dev-cant-starve-prod)).
- **The environment label can't be wrong.** Each collector upserts `deployment.environment.name` from its own `FOCUS_ENV` (`prod` or `dev`) onto every span, metric and log record. A shared collector would have to trust what each app sends.
- **Separate credentials.** Each environment's token lives in its own `/opt/focus/<env>/.env`. The two files may hold the same token or one each; with one each, dev's can be revoked without touching prod.
- **Cost:** 96 MiB of the Droplet's memory budget, already counted ([deployment.md](deployment.md#memory-dev-cant-starve-prod)).

Dev and prod are told apart in Grafana Cloud by `deployment.environment.name`, the current OpenTelemetry name for `deployment.environment`. Grafana Cloud promotes it to a label:

- metrics: `deployment_environment_name="prod"`;
- logs: `| deployment_environment_name="prod"`, which works whether Loki indexes it or keeps it as structured metadata;
- traces: `resource.deployment.environment.name="prod"`.

The local stack sets `local` (`compose.yaml`).

### Credentials

| Token | Scopes | Lives only in | Read by |
|---|---|---|---|
| OTLP write token (`GRAFANA_CLOUD_OTLP_TOKEN`) | `metrics:write`, `logs:write`, `traces:write` | `/opt/focus/prod/.env` and `/opt/focus/dev/.env` on the server (mode 600), next to `GRAFANA_CLOUD_OTLP_ENDPOINT` and `GRAFANA_CLOUD_INSTANCE_ID` ([.env.example](../.env.example), "Deployed environments") | That environment's collector |
| Read-only token (`GRAFANA_READONLY_TOKEN`) | read metrics, logs, traces | The GitHub `oncall` environment's secrets | The on-call workflow (#35) |
| GitHub dispatch token (#34), the other way round: Grafana → GitHub | fine-grained, this repo only, Contents write | The Grafana Cloud contact point `focus-oncall-github` (encrypted, read back as `[REDACTED]`) | Grafana's webhook ([Alert routing](#the-token)) |

None of these tokens is ever in git, in repo-level GitHub secrets or in any other environment; the dispatch token isn't in any GitHub environment either. `scripts/tests/test_grafana_dashboards.py` fails if a workflow mentions the OTLP token, or reads the read-only token outside a job in the `oncall` environment. To rotate the OTLP token, put the new value in both `.env` files and recreate each collector: `APP_TAG=<current tag> infra/compose.sh <env> up -d otel-collector`.

### Check that both environments arrive

In Grafana Cloud, open **Explore** and run:

| Data source | Query | Expect |
|---|---|---|
| `grafanacloud-…-prom` | `count by (deployment_environment_name) (http_server_request_duration_seconds_count{service_name="ineedtofocus"})` | A `dev` and a `prod` series (an environment shows once its app has served requests and sent metrics, within a minute) |
| `grafanacloud-…-logs` | `{service_name="ineedtofocus"} \| deployment_environment_name="prod"` | Prod's log lines |
| `grafanacloud-…-traces` | `{resource.service.name="ineedtofocus" && resource.deployment.environment.name="prod"}` | Prod's request traces |

The metrics query counts a request metric's data points, not `target_info`: `target_info` carries the resource attributes even when Grafana Cloud doesn't promote `deployment.environment.name` onto every series, and then every dashboard panel and alert query, which filter on the data points' `deployment_environment_name`, would be empty while that check passed ([#32](https://github.com/ybenzine/ineedtofocus/issues/32#issuecomment-6395384377)).

Then open the dev dashboard (**I Need To Focus: key journey (dev)**) and confirm the panels show data: the **Session saves**, **History loads** and **HTTP, every API route** rows should show lines and numbers, not "No data" (use dev once first if it has had no traffic lately).

If an environment is missing, look at its collector's logs on the server: `APP_TAG=<current tag> infra/compose.sh <env> logs otel-collector`. A 401 there means a wrong instance ID or token.

## Dashboards (#32)

One key-journey dashboard per environment: `infra/grafana/dashboards/key-journey-prod.json`, `-dev.json` and `-local.json`. The three are generated from one model, `scripts/grafana_dashboards.py`, and differ only in the environment they filter on and their default data sources. Each has a fixed UID (`focus-key-journey-<env>`) and links to the others.

| Row | Panels | Source |
|---|---|---|
| Session saves | Save success rate over the time range and over 5-minute windows (with the 95% alert line); sessions saved per minute by `outcome`; save latency p50/p95/p99 by `kind`, with exemplars that open their trace; offline sync batch size; save requests by `kind` and `outcome` | `focus_session_saves_total`, `focus_session_save_duration_seconds`, `focus_sync_batch_size` |
| History loads | p95 latency over the time range; p50/p95/p99 latency with the 2 s alert line and exemplars; loads per minute by `outcome`; error rate | `focus_history_load_duration_seconds`, `focus_history_loads_total` |
| Errors, logs and traces | Error logs (severity ERROR and above); the same lines as a table whose `trace_id` opens the trace in Explore; error log lines per minute by logger; failed requests (TraceQL, `status=error`); key-journey requests over 1 s | Loki, Tempo |
| HTTP, every API route | Requests per minute by route; 5xx ratio and p95 latency of the key-journey routes | `http_server_request_duration_seconds` (FastAPI's standard metric) |

**Metric names.** The dashboards query the Prometheus form of the OpenTelemetry metrics in [Signals](#signals). Dots become underscores, a unit of `s` adds `_seconds`, a counter adds `_total`, and annotation units such as `{session}` add nothing:

| OpenTelemetry (backend, #31) | Prometheus (dashboards) |
|---|---|
| `focus.session.saves` | `focus_session_saves_total` |
| `focus.session.save.duration` | `focus_session_save_duration_seconds_bucket` / `_count` / `_sum` |
| `focus.sync.batch.size` | `focus_sync_batch_size_bucket` / `_count` / `_sum` |
| `focus.history.loads` | `focus_history_loads_total` |
| `focus.history.load.duration` | `focus_history_load_duration_seconds_bucket` / `_count` / `_sum` |
| `http.server.request.duration` (FastAPI) | `http_server_request_duration_seconds_bucket` / `_count` / `_sum` |

**Save success rate** is `1 - outcome="error" / all sessions submitted`, the complement of the alert's save error rate: a `rejected` session (invalid input, an id conflict) was handled correctly, so it doesn't count against it. While nothing has failed, the rate reads 100%, not "no data".

### Import into Grafana Cloud (prod and dev)

Do this once, and again after a PR changes a dashboard. Grafana Cloud doesn't read the repo, and an import needs an editor's login, which no agent has.

1. In https://ineedtofocus.grafana.net, open **Dashboards**. Choose **New → New folder**, name it `I Need To Focus` and create it. Skip this step once the folder exists.
2. Choose **New → Import**. Under **Upload dashboard JSON file**, choose `infra/grafana/dashboards/key-journey-prod.json` from a checkout of `main` (or paste the file's raw GitHub contents).
3. Set **Folder** to `I Need To Focus` and leave the name and UID as they are. Choose **Import**. When re-importing, Grafana says a dashboard with that UID exists; choose **Import (Overwrite)**.
4. Repeat with `key-journey-dev.json`.
5. Open each dashboard. If a panel says the data source wasn't found, pick the stack's data sources in the **Metrics**, **Logs** and **Traces** dropdowns at the top: `grafanacloud-ineedtofocus-prom`, `-logs` and `-traces`. The defaults are Grafana Cloud's built-in UIDs (`grafanacloud-prom`, `grafanacloud-logs`, `grafanacloud-traces`), which normally match. Then **Save dashboard**.

**Changing a dashboard:** edit `scripts/grafana_dashboards.py`, run `python3 scripts/grafana_dashboards.py` and commit the regenerated JSON with it. `make test-scripts` fails when the JSON and the script disagree. After the merge, re-import. Changes made in the Grafana UI are overwritten by the next import, so move them into the script.

**Locally**, `make up` provisions `key-journey-local.json` into grafana/otel-lgtm (read-only in the UI). After regenerating it, recreate the container with `docker compose up -d lgtm`. This drops the local telemetry, which lgtm keeps in memory. `make check-stack` (in CI too) checks that the dashboard is provisioned and that each of its queries runs against Prometheus, Loki and Tempo (`python3 scripts/grafana_dashboards.py verify`). Since #33 every Prometheus query must also return data, after the probe's save and history load: an unknown metric or label parses fine and returns nothing, which would otherwise blank a panel silently. The Loki and Tempo queries only have to run, since the error panels are rightly empty while nothing fails.

### Screenshots

These come from the local stack, which uses the same model as prod and dev. They show the last 15 minutes of saves, sync batches (some with an invalid item) and history loads (some with a bad time zone), including a few seconds with Postgres stopped. Retake them with `node scripts/grafana_screenshots.mjs`.

![Key-journey dashboard, local stack: session saves and history loads](images/observability/key-journey-saves-history.png)

![Key-journey dashboard, local stack: errors, logs, traces and every API route](images/observability/key-journey-errors-http.png)

Clicking a `trace_id` in **Error logs with their traces** opens the failed request's trace in Explore:

![The trace of a failed request, opened from its error log line](images/observability/error-log-to-trace.png)
