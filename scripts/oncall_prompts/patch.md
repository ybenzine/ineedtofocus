⛔ Needs Yacine: open the on-call fix PR for incident #${incident} (#35). The workflow has no on-call App key (`ONCALL_APP_KEY` in the `oncall` environment), so it can't push the branch. Here is the agent's fix, as `${branch}` would be. Apply it with `git apply` on a branch from `main`, or have an agent session open it as a PR with `Refs #${incident}`.

```diff
${diff}
```
