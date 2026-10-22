#!/usr/bin/env bash
# Post a pull request review as the reviewer GitHub App's bot (#70).
#
#   scripts/reviewer-review.sh <pr> approve|request-changes|comment <body-file>
#   scripts/reviewer-review.sh 71 approve /tmp/review-71.md
#
# Mints an installation token with scripts/reviewer_token.py and passes it to
# `gh pr review` (--approve, --request-changes or --comment, --body-file) through
# GH_TOKEN, in this process only: the token never reaches the terminal, a log or a file.
# The review shows as the App's bot, so it can approve a PR the shared account authored,
# and its approval counts toward the review that branch protection on `main` requires.
#
# Fallback: if the App's private key is missing or unreadable (reviewer_token.py exits 3),
# the review is posted as a COMMENT review from your default gh login instead, and this
# script says so. A comment can't approve, so the merge waits for Yacine to restore the
# key (_docs/process.md §4). Any other failure (GitHub refused the token, network) stops
# without posting, so it gets looked at instead of silently downgrading the review.
#
# Env: REVIEWER_APP_ID, REVIEWER_INSTALLATION_ID, REVIEWER_APP_KEY_PATH (see .env.example);
#      REVIEWER_REPO (default ybenzine/ineedtofocus);
#      REVIEWER_REVIEW_API=rest to post through the REST API (gh api) where GraphQL is
#      unreachable.
# Needs: uv, gh.
set -euo pipefail

usage() {
  echo "usage: $0 <pr> approve|request-changes|comment <body-file>" >&2
  exit 2
}

[[ $# -eq 3 ]] || usage
pr="$1"
verdict="$2"
body_file="$3"
repo="${REVIEWER_REPO:-ybenzine/ineedtofocus}"

[[ "$pr" =~ ^[0-9]+$ ]] || { echo "PR number must be numeric, got: $pr" >&2; exit 2; }
case "$verdict" in
  approve) flag=--approve event=APPROVE ;;
  request-changes) flag=--request-changes event=REQUEST_CHANGES ;;
  comment) flag=--comment event=COMMENT ;;
  *) usage ;;
esac
[[ -s "$body_file" ]] || { echo "review body file is missing or empty: $body_file" >&2; exit 2; }

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

post() { # <flag> <event>: post the review with whatever credentials gh has in its env
  if [[ "${REVIEWER_REVIEW_API:-}" == rest ]]; then
    gh api --method POST "repos/$repo/pulls/$pr/reviews" \
      -f "event=$2" -F "body=@$body_file" --jq '"Review \(.id) posted by \(.user.login): \(.state)"'
  else
    gh pr review "$pr" --repo "$repo" "$1" --body-file "$body_file"
  fi
}

status=0
token="$(uv run --quiet --locked --script "$here/reviewer_token.py")" || status=$?

case "$status" in
  0)
    GH_TOKEN="$token" post "$flag" "$event"
    token=""
    echo "Posted the $verdict review on #$pr as the reviewer App."
    ;;
  3)
    token=""
    echo "Fallback: the reviewer App key is unavailable (see the message above)." >&2
    echo "Posting a COMMENT review from the default gh login instead; it can't approve," >&2
    echo "so the merge waits for Yacine to restore the key (_docs/process.md §4)." >&2
    post --comment COMMENT
    echo "Fallback: posted a COMMENT review on #$pr (verdict $verdict is in the body, not an approval)."
    ;;
  *)
    token=""
    echo "Could not mint a reviewer App token (exit $status); no review posted." >&2
    exit "$status"
    ;;
esac
