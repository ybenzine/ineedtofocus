# GitHub repository settings

Settings that live on GitHub rather than in a workflow, kept here so they are reviewed like code.

## Branch protection on `main` (#5)

[`main-branch-protection.json`](main-branch-protection.json) is the full payload for GitHub's "update branch protection" REST endpoint. Apply it (or re-apply it after a change) from the repo root:

```sh
gh api --method PUT repos/ybenzine/ineedtofocus/branches/main/protection \
  --input infra/github/main-branch-protection.json
```

Changing protection is a [human gate](../../_docs/process.md#human-gates): the project's Claude Code permissions ask before any `gh api` call on `…/protection`, and agents never weaken it to get a PR merged.

| Setting | Value | Why |
|---|---|---|
| Required status checks | The five CI jobs in [`.github/workflows/ci.yml`](../../.github/workflows/ci.yml), by job name: `Lint and type-check`, `Backend unit tests`, `Backend integration tests`, `Frontend unit tests`, `End-to-end (Compose stack)` | A PR merges only with all of CI green |
| Check source | `app_id` 15368 (GitHub Actions) | Only an Actions run can satisfy a check; a commit status with the same name posted through the API can't |
| Branch up to date before merge (`strict`) | Off | Agents merge many small PRs; forcing an update of each branch after every merge would stall the queue. CI also runs on every push to `main`, so a semantic conflict between two green PRs shows up there at once |
| Include administrators (`enforce_admins`) | On | Every agent acts as the repo owner, so without this the owner (and so every agent) could bypass the checks |
| Force pushes | Blocked | No history rewrites on `main` |
| Deletion | Blocked | `main` can't be deleted |
| Required reviews | None | All agents share one GitHub account, and GitHub doesn't let a PR's author approve it. The reviewer agent's `Verdict: Approve` comment is the merge signal ([process.md](../../_docs/process.md#4-review)) |

Because the required checks apply to administrators too, a direct push to `main` is rejected as well: its commit has no passing checks.

**Renaming a CI job** changes its check name. Update the `checks` list here and re-apply it in the same PR. Otherwise every PR waits forever for a check that no longer runs.
