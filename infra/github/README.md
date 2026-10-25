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
| Include administrators (`enforce_admins`) | On | Agents act as `merciful-poseidon`, which isn't an administrator ([below](#agent-account-127)), but the owner is. Without this, the owner's login, or a session started without `claude-focus` that falls back to it, could bypass the checks and the review |
| Force pushes | Blocked | No history rewrites on `main` |
| Deletion | Blocked | `main` can't be deleted |
| Required approving reviews | 1 | Every PR needs an approval before it merges. All agents share one account, `merciful-poseidon` ([below](#agent-account-127)), which authors the PRs and so can't approve them; the approval comes from the **reviewer GitHub App**'s bot ([below](#reviewer-github-app-70)). The reviewer agent's `Verdict: Approve` review is that approval |
| Dismiss stale approvals on new commits (`dismiss_stale_reviews`) | On | What merges is exactly what the reviewer approved. A push after the approval (a late fix, a merge from `main`) dismisses it, and the lead runs the reviewer again. The cost is one more reviewer round in that case, which the process asks for anyway |
| Require approval of the most recent push (`require_last_push_approval`) | On | The latest push to a PR must be approved by someone other than whoever pushed it. In the normal flow the agent account pushes and the bot approves, so nothing changes. But if the bot's token leaks and is used to push to a PR branch, the bot's own approval no longer counts, and the agent account can't approve its own PR, so that PR can't merge. Stale-approval dismissal alone wouldn't stop this: the bot could push and then approve again |
| Code owner reviews | Off | No `CODEOWNERS`; the reviewer agent reviews everything |

Because the required checks apply to administrators too, a direct push to `main` is rejected as well: its commit has no passing checks and no approval. A request-changes review from the bot also blocks the merge until the bot approves a later round.

**Renaming a CI job** changes its check name. Update the `checks` list here and re-apply it in the same PR. Otherwise every PR waits forever for a check that no longer runs.

## Agent account (#127)

Agents don't act as Yacine. They use a machine account of their own, so the `production` environment's approval holds against them: that account can't approve a prod deploy or change an environment's protection rules, whatever command it runs.

| Identity | Kind | Used for | Access |
|---|---|---|---|
| `ybenzine` | Yacine, the repo owner | Approving prod deploys (the only required reviewer of `production`), admin settings (branch protection, environments, secrets, collaborators), `owner:human` tasks | Admin |
| `merciful-poseidon` | Machine account: a regular GitHub user, not an App | Everything the agents do: issues and comments, branches and pushes, PRs and merges, the board, re-running CI, the `rollback` workflow (#30) | Write on the repo (collaborator) and on the board |
| `ineedtofocus-reviewer[bot]` | GitHub App ([below](#reviewer-github-app-70)) | The approving or request-changes review on every PR | Pull requests and Contents write |

### Setup (Yacine, once per machine)

1. **Log the bot in to a gh config directory of its own**, outside the repo. Do it in a private browser window signed in as `merciful-poseidon`, so you don't authorize as yourself:

   ```sh
   GH_CONFIG_DIR=$HOME/.config/ineedtofocus/gh-bot \
     gh auth login --hostname github.com --git-protocol https --web --scopes workflow,project
   ```

   `gh auth login` always requests `repo`, `read:org` and `gist`; `--scopes` adds the rest. gh keeps the token in the macOS keychain, and the config directory records which account to use. Nothing lands in the repo. `.claude/settings.json` denies Claude's file tools on `~/.config/ineedtofocus/`, as for the reviewer App's key.

   | Scope | Why |
   |---|---|
   | `repo` | Issues, comments, labels, branches, pushes, PRs, merges, dispatching and re-running workflows |
   | `workflow` | Pushing commits that change `.github/workflows/` (the DevOps agent's PRs) |
   | `project` | The board: `scripts/board-status.sh` moves cards |
   | `read:org` | gh's default; harmless on a user-owned repo |

   `gist` is also one of gh's defaults. Agents don't use it.

2. **Start every agent session through an alias** that points `gh` at that directory:

   ```sh
   alias claude-focus='GH_CONFIG_DIR=$HOME/.config/ineedtofocus/gh-bot claude'
   ```

   The alias may also set `GIT_AUTHOR_NAME`/`GIT_COMMITTER_NAME` to `merciful-poseidon` and `GIT_AUTHOR_EMAIL`/`GIT_COMMITTER_EMAIL` to `347635949+merciful-poseidon@users.noreply.github.com`, so commits show the bot as author. That's cosmetic: no gate depends on the commit author, only on who pushes, opens and approves.

3. **Make `git push` go out as the bot too.** git asks a credential helper for the password. For `https://github.com` that helper must be `gh auth git-credential`, which honours `GH_CONFIG_DIR`. `gh auth setup-git` writes these lines to `~/.gitconfig`:

   ```ini
   [credential "https://github.com"]
   	helper =
   	helper = !/opt/homebrew/bin/gh auth git-credential
   ```

   Yacine's clone also has the pair in its own `.git/config` (local to the clone, not committed), with `helper = !gh auth git-credential`, which finds `gh` through `PATH` instead of the absolute path. Either is enough.

   The empty `helper =` resets the list of helpers, so the system-wide `osxkeychain` helper (Homebrew git's `/opt/homebrew/etc/gitconfig`) is skipped. That keychain entry is Yacine's login. **If these lines are removed, `git push` silently falls back to the keychain and pushes as Yacine.** `gh auth setup-git`, run in a `claude-focus` session, restores them.

### Checking a session

- `gh auth status` should say `Logged in to github.com account merciful-poseidon`, with token scopes including `repo`, `workflow`, `project` and `read:org`. `gh api user --jq .login` prints `merciful-poseidon`.
- `git config --show-origin --get-all credential.https://github.com.helper` should show the empty entry followed by `gh auth git-credential`. git then pushes as whichever account `gh auth status` shows, so for agents these two checks are enough.
- To see directly which account git would push as, in your own terminal (agents can't: `.claude/settings.json` denies `git credential fill`, whose unfiltered output is the token, #174): `printf 'protocol=https\nhost=github.com\n\n' | git credential fill | grep '^username='` should print `username=merciful-poseidon`.

Agents never run `gh auth status --show-token` (`-t`), `gh auth token`, `gh auth git-credential`, `git credential fill`, a `git credential-<helper>` or the `security` keychain reads: each prints the bot's token, and `.claude/settings.json` denies them (#174). Only plain `gh auth status` and a few exact variants run without a prompt; see [CLAUDE.md](../../CLAUDE.md#permissions-for-unattended-runs).

If `gh auth status` shows `ybenzine`, the session wasn't started with `claude-focus`. Agents stop and ask for a restart instead of working as Yacine.

### What the account can't do

| Action | Why it can't |
|---|---|
| Approve or reject a `production` deployment (`pending_deployments`, the GraphQL `approveDeployments` mutation, the run page) | Only the environment's required reviewers can, and the only one is `ybenzine`. Administrators can't bypass it (`can_admins_bypass: false`), and the account isn't one anyway |
| Create, edit or delete an environment, its protection rules or branch rules | GitHub requires admin access for these. The account has write |
| Read a secret's value, in any environment | The API only ever returns secret names. Values reach only the jobs of an approved run |
| Change branch protection, rulesets, collaborators, webhooks, deploy keys or Actions settings | Admin only, as above |
| Approve its own PRs, or merge without the bot's approval and the five checks | Branch protection, administrators included |

What it **can** do, as any writer: push to every branch except `main`, open and merge approved PRs, dispatch any workflow and re-run runs, and create tags and releases. It can list secret names, and it can most likely **overwrite** environment secrets, `production`'s included: GitHub lets collaborators with write access create and update them. That could break prod deploys (a replaced `DEPLOY_SSH_KEY` can't log in to the server, a wrong `DEPLOY_KNOWN_HOSTS` fails the host check), but not get a deploy through, since every run still waits for Yacine's approval. `.claude/settings.json` denies `gh secret set` and asks before `gh api` calls on environments (#52); like all its rules, they match command text only. Overwriting wasn't tried. Dispatching includes `deploy-prod`: #126's deny rules in `.claude/settings.json` stop agents from starting it, and a run started anyway waits for Yacine's approval at the `deploy` job. #126's rules stay as a second line. No deploy starts on a tag or release (#29).

**Verified on 2026-10-25**, read-only, from a session running as `merciful-poseidon`:

| Check | Result |
|---|---|
| `gh api user --jq '{login, type}'` | `{"login":"merciful-poseidon","type":"User"}` |
| `gh api repos/ybenzine/ineedtofocus --jq .permissions` | `{"admin":false,"maintain":false,"pull":true,"push":true,"triage":true}` |
| `gh api repos/ybenzine/ineedtofocus/collaborators/merciful-poseidon/permission --jq .role_name` | `write` |
| `gh api repos/ybenzine/ineedtofocus/environments/production` | `can_admins_bypass: false`; one `required_reviewers` rule whose only reviewer is the user `ybenzine`; deployment branches: custom policies (`main`) |
| Admin-only reads: `gh api repos/ybenzine/ineedtofocus/hooks`, `…/keys`, `…/actions/permissions` | `404`, `404`, `403`: GitHub treats the account as a non-admin |
| `gh secret list --env production` | Names only: `DEPLOY_KNOWN_HOSTS`, `DEPLOY_SSH_KEY`. The account can see the secrets exist; this check doesn't say whether it can overwrite them (above) |
| `git credential fill` for `github.com` | `username=merciful-poseidon` |

These checks cover approving deployments and editing environments and their protection rules, not secrets: see above for what the account can do to secrets. No request that could change a setting or a secret was sent to prove the negative: if it had worked, it would have changed it. Approving a deployment isn't tried either. `.claude/settings.json` denies `pending_deployments` and `approveDeployments` commands (#126), and the reviewer list above already rules it out. The normal loop (issue comments, board moves, pushing a branch, opening and merging the PR) is #127's own trail, all done as `merciful-poseidon`.

**Residual risk:** the bot shares the machine and the macOS user with Yacine. If Yacine's own login is still there (gh's default config directory `~/.config/gh`, or the keychain entry git used before step 3), a command that drops `GH_CONFIG_DIR` (`env -u GH_CONFIG_DIR gh …`), or a session started with plain `claude`, acts as Yacine again. So the separation holds against mistakes and against the agent's own credential, not against an agent on Yacine's machine set on getting past it. Closing that gap needs Yacine's login off the machine while agents run, for example a separate macOS user for agent sessions.

**Rotating the bot's token:** `GH_CONFIG_DIR=$HOME/.config/ineedtofocus/gh-bot gh auth refresh`, or log out and log in again (step 1). To cut the bot off entirely, remove `merciful-poseidon` from the repo's collaborators and from the board.

## Reviewer GitHub App (#70)

The reviewer agent posts every PR review as a GitHub App's bot, so it can submit a real `APPROVE` or `REQUEST_CHANGES` review on PRs the agent account authored. It's the pattern Dependabot and Renovate use: a bot identity with short-lived tokens, free and seatless.

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

**Fallback when the key is missing or unreadable:** `reviewer-review.sh` posts the review as a COMMENT from the session's own gh login (the agent account) and says so. A comment can't approve, so the PR can't merge. The lead stops with `⛔ Needs Yacine:` and Yacine restores the key: App settings → *Private keys* → *Generate a private key*, saved to the path above with `chmod 600`. The reviewer then posts its review again through the App. Any other token failure (GitHub refused the token, no network) posts nothing, so it gets looked at instead of silently downgrading the review.

**Accepted cost of Contents write:** a leaked token (it lives one hour), or a leaked key that can mint new tokens, can:
- push to any branch except `main`, including open PR branches (but not workflow files: the App has no Workflows permission);
- open, approve and merge PRs through the API.

What keeps such a token from getting code into `main` is branch protection, not the token's scope:
- **Last-push approval by a different actor** (`require_last_push_approval`): if the bot pushes to a PR branch, its own approval of that PR doesn't count, and the agent account can't approve its own PRs. So a PR the bot pushed to can't merge until the agent account pushes again and the reviewer re-approves the new commit (stale approvals are dismissed).
- **The five required CI checks**, which only a GitHub Actions run can satisfy.
- **Administrators included** (`enforce_admins`): nobody, including the owner, can bypass the two rules above.

The residual risk is narrower but real. With a leaked token, an attacker can approve any open PR whose last push came from the agent account, and merge it once CI is green, skipping the reviewer agent. Getting the attacker's own code into such a PR still needs the agent account itself.

- **Tags and releases:** Contents write also lets a leaked token create tags and releases. Prod deploys (#27–#30) therefore must not trigger on a tag or release unless the run goes through the approval-gated `production` environment, or tag creation is restricted by a tag ruleset.

To limit exposure, the key stays on Yacine's machine, a token is minted per review and never written anywhere, and the token script asks before running directly in Claude Code. If the key may have leaked, delete it in the App's settings (that also stops new tokens) and generate a new one.

**Rotating the key:** generate a new key in the App's settings, replace the file, then delete the old key there. Nothing else holds a copy.

**Headless runs** such as the on-call workflow (#35) don't have the key. Until it's provided to them (for example as a secret of the `oncall` environment), their reviews fall back to comments and their merges wait for Yacine.
