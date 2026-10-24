# Roll back dev or prod

The procedure behind every alert runbook's "roll back" decision, and for anyone who needs to undo a deploy. A rollback to a known-good release **needs no approval**, prod included ([process.md → Human gates](../process.md#human-gates)). It can't deploy anything new. How it works: [deployment.md → Rollback](../deployment.md#rollback-rollbackyml).

## Impact

Rolling back swaps the app container only: a few seconds of `502` from Caddy while the older release starts. The database isn't touched: no migration runs and none is undone. Data written since the deploy stays. The older release runs on today's schema because migrations are expand-first ([AGENTS.md](../../AGENTS.md#conventions)): a migration only adds, until a deliberate contract migration removes something. Rolling back past a contract migration isn't safe, and until #165 adds a rollback floor nothing stops it, so check `backend/migrations/versions/` for a `# contract-migration:` step between the two releases first.

## Check

- **Did the problem start with a deploy?** Compare the alert's start time with the latest deploy of that environment:
  - prod: `gh run list --workflow deploy-prod.yml --limit 5` (open the run: its summary shows the tag, the time and the rollback target)
  - dev: `gh run list --workflow ci.yml --branch main --event push --limit 5` (the `Deploy to dev` job's summary)
  - telemetry: the `service.version` resource attribute is the commit sha that produced it.
- **Did the deploy fail on its own?** A deploy whose checks failed after the start has already put the previous release back (automatic revert): its job is red, and its log says `reverted to <tag>`. Nothing to roll back then.

## Decide

Roll back when the problem started with a deploy, and the release before it was fine. Don't roll back when:

- the cause isn't the release (the database, the host, Grafana Cloud): a rollback won't help;
- the bad change is a migration. A rollback never undoes one, so the older release would see the same data. Fix forward instead.

## Act

Run the workflow **once**, from the default branch (`main`), with only these inputs. Keep `rollback.yml` straight after `gh workflow run`: that's what `.claude/settings.json` allows without a prompt. A flag before it (`--ref main`) prompts, and free text could hit a deny rule.

```bash
gh workflow run rollback.yml -f env=prod                 # prod, the last known-good release
gh workflow run rollback.yml -f env=dev                  # dev, the last known-good release
gh workflow run rollback.yml -f env=prod -f tag=<sha>    # a specific known-good release (40-hex commit sha)
```

"Last known-good" is the newest release that passed the checks on that environment, isn't the one running now, and wasn't rolled back from. Pass `tag` only to skip further back, for example past a release whose smoke tests failed. The server refuses a sha that isn't a known-good release there.

Then follow the run (it appears a few seconds after the dispatch; take the one created after you started it):

```bash
gh run list --workflow rollback.yml --limit 1 --json databaseId,createdAt,status,conclusion,url
gh run watch <databaseId> --exit-status
```

**Don't re-run a rollback that succeeded:** each one goes one release further back. If it failed, read its log and the table below first. A run that's still waiting (another rollback of that environment is running) is replaced by a newer dispatch: GitHub keeps one pending run per group, so a duplicate dispatch drops the waiting one rather than going back twice.

## Verify

1. The run is green and its summary shows **From** (the release left) and **To** (what runs now), and the smoke tests passed.
2. The alert resolves and the key-journey metrics recover (session saves, history latency) in Grafana.
3. For dev: the summary says the release left is marked as rolled back from. Prod won't take it (`deploy-prod` stops before deploying it) until dev runs it again.

| The run says | Meaning | Next |
|---|---|---|
| `Not rolled back: the dev/rollback environment has no DEPLOY_SSH_KEY …` | The environment isn't set up yet (#28, #30 setup) | `⛔ Needs Yacine:` the one-time setup in [deployment.md → Rollback](../deployment.md#one-time-setup-yacine-2) |
| `Wrong key` | The environment holds another environment's key; nothing changed | `⛔ Needs Yacine:` fix that environment's secret |
| `nothing to roll back to` | No known-good release other than the current one | Fix forward |
| `… runs <tag> (<digest>) now, not the expected …` | A deploy or another rollback ran between the run's read and its request; nothing changed | Check what runs now (the latest deploy summary), then decide again |
| `Wrong key: the rollback environment's key isn't the prod rollback key` | The `rollback` environment holds a key that can do more than roll back | `⛔ Needs Yacine:` replace it with the `focus-ci-rollback` key |
| `releases.log line <n> is malformed` | A line focus-ci wouldn't write: a write cut short (for example a full disk) or a hand edit. Nothing that reads that log runs | `⛔ Needs Yacine:` look at it read-only first, `sudo sed -n '<n>p' /opt/focus/<env>/releases.log`, then move that line out of the file. Check the disk too (`df -h /`) |
| `no known-good release of <sha> is recorded` | That sha never passed the checks there, is current, or was rolled back from | Leave `tag` out, or pick another sha from the deploy summaries |
| `rollback of <sha> failed at 'start' … reverted to <tag>` | The target didn't pass its checks either; the server started the release it left again | The cause is probably not the release: investigate, don't retry blindly |
| `… and reverting to <tag> failed too` | The environment may be down | `⛔ Needs Yacine:` server access ([deployment.md → Rollback](../deployment.md#rollback-rollbackyml), break-glass) |
| Rolled back, smoke tests failed | The older release runs but isn't healthy from outside (Caddy, DNS, certificate) | Investigate the edge; not a release problem |

## Report

On the incident issue: the rollback run's link, From and To (tag and digest from its summary), when it finished, whether the alert resolved, and the follow-up (a fix PR with a regression test, `oncall/<incident>-<slug>`). The fix reaches prod through a normal deploy, which Yacine approves.
