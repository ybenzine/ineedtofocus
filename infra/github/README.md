# GitHub repository settings

Settings that live on GitHub rather than in a workflow, kept here so they are reviewed like code.

## Branch protection on `main` (#5, #70)

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
| Include administrators (`enforce_admins`) | On | Every agent acts as the repo owner, so without this the owner (and so every agent) could bypass the checks and the review |
| Force pushes | Blocked | No history rewrites on `main` |
| Deletion | Blocked | `main` can't be deleted |
| Required approving reviews | 1 | Every PR needs an approval before it merges. All agents share Yacine's account, which authors the PRs and so can't approve them; the approval comes from the **reviewer GitHub App**'s bot ([below](#reviewer-github-app-70)). The reviewer agent's `Verdict: Approve` review is that approval |
| Dismiss stale approvals on new commits (`dismiss_stale_reviews`) | On | What merges is exactly what the reviewer approved. A push after the approval (a late fix, a merge from `main`) dismisses it, and the lead runs the reviewer again. The cost is one more reviewer round in that case, which the process asks for anyway |
| Require approval of the most recent push (`require_last_push_approval`) | Off | Redundant here: stale approvals are dismissed, and the pusher (the shared account) can never approve |
| Code owner reviews | Off | No `CODEOWNERS`; the reviewer agent reviews everything |

Because the required checks apply to administrators too, a direct push to `main` is rejected as well: its commit has no passing checks and no approval. A request-changes review from the bot also blocks the merge until the bot approves a later round.

**Renaming a CI job** changes its check name. Update the `checks` list here and re-apply it in the same PR. Otherwise every PR waits forever for a check that no longer runs.

## Reviewer GitHub App (#70)

The reviewer agent posts every PR review as a GitHub App's bot, so it can submit a real `APPROVE` or `REQUEST_CHANGES` review on PRs the shared account authored. It's the pattern Dependabot and Renovate use: a bot identity with short-lived tokens, free and seatless.

| | |
|---|---|
| App | Owned by `ybenzine`, installed on `ybenzine/ineedtofocus` only. No webhook. Repository permissions: Pull requests read & write, **Contents read & write**, Metadata read. Contents write is needed only so the bot's approval counts: GitHub counts an approval toward required reviews only from an identity with write access to the repository |
| App ID / installation ID | `5420413` / `173980330`. Public; they're the defaults of `REVIEWER_APP_ID` / `REVIEWER_INSTALLATION_ID` in [`.env.example`](../../.env.example) |
| Private key | `~/.config/ineedtofocus/reviewer-app.pem`, mode 600, on Yacine's machine only (`REVIEWER_APP_KEY_PATH`). Never in the repo, a comment or a log. `.claude/settings.json` denies Claude's file tools on `~/.config/ineedtofocus/` |
| Token | [`scripts/reviewer_token.py`](../../scripts/reviewer_token.py) signs a 10-minute JWT with the key (PyJWT, RS256; dependencies pinned in the script and locked with hashes in `scripts/reviewer_token.py.lock`, run with `uv run --locked`) and exchanges it for an installation token: this repository only, Pull requests write and Contents write, valid for one hour. It prints the token on stdout and nothing else, refuses to print it to a terminal, and its errors never contain the key, the JWT or the token |
| Posting a review | [`scripts/reviewer-review.sh`](../../scripts/reviewer-review.sh) `<pr> approve\|request-changes\|comment <body-file>` mints a token and runs `gh pr review <pr> --approve\|--request-changes\|--comment --body-file <body-file>` with it in `GH_TOKEN`, for that one process. `REVIEWER_REVIEW_API=rest` posts through `gh api …/pulls/<pr>/reviews` instead, where GraphQL is unreachable |

The same thing by hand, for a human at a shell (the token only ever lives in the command substitution). Claude Code asks before running the token script directly, since its stdout is the token:

```sh
GH_TOKEN="$(uv run --quiet --locked --script scripts/reviewer_token.py)" \
  gh pr review <pr> --approve --body-file /tmp/review-<pr>.md
```

**Fallback when the key is missing or unreadable:** `reviewer-review.sh` posts the review as a COMMENT from the default gh login and says so. A comment can't approve, so the PR can't merge. The lead stops with `⛔ Needs Yacine:` and Yacine restores the key: App settings → *Private keys* → *Generate a private key*, saved to the path above with `chmod 600`. The reviewer then posts its review again through the App. Any other token failure (GitHub refused the token, no network) posts nothing, so it gets looked at instead of silently downgrading the review.

**Accepted cost of Contents write:** a leaked token (it lives one hour) or a leaked key could push to any unprotected branch of this repository, or open and approve a PR. It can't touch `main`: branch protection requires the CI checks on every change to `main`, with administrators included, and `dismiss_stale_reviews` drops an approval when new commits land. The key stays on Yacine's machine, tokens are minted per review and never written anywhere, and the token script asks before running directly in Claude Code. If the key may have leaked, delete it in the App's settings (that also stops new tokens) and generate a new one.

**Rotating the key:** generate a new key in the App's settings, replace the file, then delete the old key there. Nothing else holds a copy.

**Headless runs** such as the on-call workflow (#35) don't have the key. Until it's provided to them (for example as a secret of the `oncall` environment), their reviews fall back to comments and their merges wait for Yacine.
