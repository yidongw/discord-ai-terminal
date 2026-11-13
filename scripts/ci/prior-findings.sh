#!/usr/bin/env bash
# prior-findings <base> <head> — the review ledger's input (owner 11-12): for every sha a Review-Fix-Of: trailer in
# base..head names, print the blocking findings of the newest failed Review run of that sha ("review <S>" on dev,
# "recheck <S>" on main) — the findings the fixer was given. review-gate.ts --prior puts them, with the fixers'
# Review-Disputed: trailers, into the re-review prompt. Read-only (GH_TOKEN with actions: read); prints nothing and
# exits 0 when there is nothing to fetch or the API fails: the re-review then reads the fix commits instead.
set -uo pipefail
REPO=${REPO:-${GITHUB_REPOSITORY:-yidongw/discord-ai-terminal}}
API=${GITHUB_API_URL:-https://api.github.com}
api() { curl -fsSL -m 30 -H "Authorization: Bearer ${GH_TOKEN:-}" -H "Accept: application/vnd.github+json" "$API/repos/$REPO/$1"; }
note() { echo "prior-findings: $*" >&2; }   # diagnostics go to the job log; stdout is the ledger
fixes=$(git log --format=%B "$1..$2" 2>/dev/null | sed -nE 's/^Review-Fix-Of: ([0-9a-f]{40})[[:space:]]*$/\1/p' | awk '!seen[$0]++')
[ -n "$fixes" ] || exit 0
# 11-13: the review.yml step ran without GH_TOKEN — every call was a 404 on the private repo and nothing said why
[ -n "${GH_TOKEN:-}" ] || { note "no GH_TOKEN — previous findings of $(tr '\n' ' ' <<<"$fixes")unavailable"; exit 0; }
review_api() { api "$1"; }
. "$(dirname "${BASH_SOURCE[0]}")/review-runs.sh"   # only trusted runs' findings reach the reviewer's prompt; every page
runs=$(review_runs completed | jq -s '{workflow_runs: .}')
for s in $fixes; do
  rid=$(jq -r --arg a "review $s" --arg b "recheck $s" \
    '[.workflow_runs[]? | select((.display_title == $a or .display_title == $b) and .conclusion == "failure")][0].id // empty' <<<"$runs" 2>/dev/null)
  [ -n "$rid" ] || { note "no failed review run found for ${s:0:12}"; continue; }
  jid=$(api "actions/runs/$rid/jobs" | jq -r '.jobs[]? | select(.name == "review") | .id' 2>/dev/null | head -1)
  [ -n "$jid" ] || { note "run $rid (${s:0:12}): no review job"; continue; }
  out=$(api "actions/jobs/$jid/logs" | sed -E 's/^[^ ]+ //' | grep -E '^(review-gate: (BLOCKED|NIT)|evidence:)')
  if [ -n "$out" ]; then printf '== the review that blocked %s (run %s):\n%s\n' "$s" "$rid" "$out"; note "previous findings of ${s:0:12} attached (run $rid)"
  else note "run $rid (${s:0:12}): log unavailable or no findings in it"; fi
done
exit 0
