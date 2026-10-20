#!/usr/bin/env bash
# Move an issue or PR to a Status column on the project board.
#
#   scripts/board-status.sh <issue-or-pr-number> "<Status>"
#   scripts/board-status.sh 10 "In progress"
#
# Status names are matched case-insensitively against the board's Status
# options (Todo, In progress, In review, Done). Adds the item to the board
# first if it isn't there yet.
#
# Needs: gh with the `project` scope (gh auth refresh -s project) and jq.
set -euo pipefail

if [[ $# -ne 2 ]]; then
  echo "usage: $0 <issue-or-pr-number> \"<Status>\"" >&2
  exit 2
fi

number="$1"
status="$2"
owner="${BOARD_OWNER:-ybenzine}"
project="${BOARD_NUMBER:-2}"
repo="${BOARD_REPO:-ybenzine/ineedtofocus}"

project_id="$(gh project view "$project" --owner "$owner" --format json --jq .id)"
fields="$(gh project field-list "$project" --owner "$owner" --format json)"
field_id="$(jq -r '.fields[] | select(.name == "Status") | .id' <<<"$fields")"
option_id="$(jq -r --arg s "$status" \
  '.fields[] | select(.name == "Status") | .options[] | select((.name | ascii_downcase) == ($s | ascii_downcase)) | .id' \
  <<<"$fields")"

if [[ -z "$option_id" ]]; then
  echo "No Status option named '$status'. Available:" >&2
  jq -r '.fields[] | select(.name == "Status") | .options[].name' <<<"$fields" >&2
  exit 1
fi

item_id="$(gh project item-list "$project" --owner "$owner" --format json --limit 1000 |
  jq -r --argjson n "$number" --arg r "github.com/$repo/" \
    '.items[] | select(.content.number == $n and ((.content.url // "") | contains($r))) | .id' | head -n1)"

if [[ -z "$item_id" ]]; then
  url="$(gh api "repos/$repo/issues/$number" --jq .html_url)"
  item_id="$(gh project item-add "$project" --owner "$owner" --url "$url" --format json --jq .id)"
fi

gh project item-edit --id "$item_id" --project-id "$project_id" \
  --field-id "$field_id" --single-select-option-id "$option_id" >/dev/null
echo "#$number → $status"
