The on-call workflow (#35) merged fix PR #${pr} for incident #${incident} as `${sha}`, after the reviewer App's approval and green CI. That deploys it to dev; prod still runs the release with the problem.

⛔ Needs Yacine: deploy the fix to prod for incident #${incident}. Once the **Deploy to dev** job of the CI run for `${sha}` on `main` has passed, go to **Actions → deploy-prod → Run workflow** on branch `main` with `tag` `${sha}`. Read the plan's summary, then approve the `production` deployment. The alert resolves once prod runs the fix, and the resolved run closes this incident.
