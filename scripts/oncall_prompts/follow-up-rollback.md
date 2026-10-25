## The rollback

The workflow's rollback job ran `gh workflow run rollback.yml -f env=${env}${tag_flag}`. Result: **${rollback_result}**, run ${rollback_run}.

1. Read the run's summary (`gh run view <run id>`) and post it on the incident: From and To (tag and digest), the time, and the smoke tests. If it failed, follow the table in `_docs/runbooks/rollback.md` and don't start another rollback; that's for a person to decide (`⛔ Needs Yacine:`).
2. Verify: `wait ${alert} ${env} normal --minutes 15`, then `journey ${env}`.
3. Report on the incident: timeline (UTC), cause, action, verification, follow-ups. Open each follow-up as a new issue, for example the fix with a regression test. If the alert resolved, close the incident issue. If it didn't, say so, post `⛔ Needs Yacine:` with your findings and add the `needs-yacine` label.
