#!/usr/bin/env bash
# The reviewed range of a main re-check — discord-ai-terminal's review contract (CLAUDE.md "Shipping"; adapted from
# yidongw/tralyx's script of the same name, 11-13). Main has ONE reviewer at a time (review.yml's job concurrency
# review-main-reviewer) and it reviews EVERY commit that reached main since the last completed main review — hotfixes,
# Train-Merge heads (merge resolutions) and the tests-only dev fixes they bring — each once.
#
#   hotfix-review-base.sh [<head>]
#     → base = the newest first-parent ancestor of <head> whose main review ("recheck <sha>") COMPLETED: its blocking
#       step "Review (blocking …" succeeded, or failed with the reviewer's "review-gate: BLOCKED #n" verdict in the log.
#       A review job that was cancelled, skipped, timed out or died before the reviewer gave a verdict reviewed nothing:
#       its commits ride this range. Nothing is moved past (no "reviewed elsewhere" shortcut on main).
#       Only trusted runs count (review-runs.sh), and only a review whose attestation artifact is still usable is a
#       base (review-passed.sh's chain needs it): one without is passed over and the range grows to an older base.
#       None found within REVIEW_BASE_DEPTH (50) first-parent commits → the deployed sha (tag `deployed`, moved by the
#       cx43 autodeploy) when it is below <head>, else <head>^1 — never ancient history.
#     A repair is reviewed in its range with the previous findings (prior-findings.sh).
#
# "Last reviewed" comes from the Review runs themselves (GitHub API, the workflow's read-only token), not from a marker
# ref the review job would push: a marker needs contents: write in the job that checks out the candidate, is lost when
# the job dies between the review and the push, and can disagree with the runs that review-dispatch.sh and autodeploy
# read; the runs are the record both already trust. Run in the candidate checkout. GH_TOKEN (actions: read), REPO.
set -euo pipefail

head=$(git rev-parse "${1:-HEAD}^{commit}")
parent=$(git rev-parse -q --verify "$head^1^{commit}") || { echo 'Review range requires a parent' >&2; exit 1; }
REPO=${REPO:-${GITHUB_REPOSITORY:-yidongw/discord-ai-terminal}}
API=${GITHUB_API_URL:-https://api.github.com}
DEPTH=${REVIEW_BASE_DEPTH:-50}
api() { curl -fsSL -m 30 -H "Authorization: Bearer ${GH_TOKEN:-}" -H "Accept: application/vnd.github+json" "$API/repos/$REPO/$1"; }

# A main review COMPLETED only when its blocking step ran to a verdict (discord-ai-terminal contract, CLAUDE.md "Shipping"):
# the step "Review (blocking …" succeeded, or failed WITH the reviewer's "review-gate: BLOCKED #n" in the job log. A review
# job that died in its setup or commit gates, timed out, was cancelled or skipped reviewed nothing: its commits stay in range.
review_api() { api "$1"; }
. "$(dirname "${BASH_SOURCE[0]}")/review-runs.sh"   # review_runs / review_attested: the one provenance rule
. "$(dirname "${BASH_SOURCE[0]}")/review-coverage.sh"
# The same anchor used on fallback must also be reachable through every incremental base's proof.
d=$(git rev-parse -q --verify "refs/tags/deployed^{commit}" 2>/dev/null || true)
if [ -n "$d" ] && [ "$d" != "$head" ] && git merge-base --is-ancestor "$d" "$head"; then anchor=$d; else anchor=$parent; fi
# "<sha> <run id>" of every trusted "recheck <sha>" run (the API lists newest first; every page)
runs=$(review_runs | jq -r 'select(.display_title | test("^recheck [0-9a-f]{40}$")) | "\(.display_title[8:]) \(.id)"')
base=""
if [ -n "$runs" ]; then
  for c in $(git rev-list --first-parent -n "$DEPTH" "$parent"); do
    for id in $(awk -v c="$c" '$1 == c { print $2 }' <<<"$runs"); do
      review_link "$id" "$c" "$anchor" "$head" 0 && { base=$c; break 2; }
      echo "hotfix-review-base: the review of ${c:0:12} (run $id) has no usable coverage chain — not a base, its commits are reviewed again" >&2
    done
  done
fi
if [ -z "$base" ]; then
  # first run (contract (f)): from what is deployed — the tag `deployed`, moved by ~/bin/discord-ai-terminal-autodeploy after
  # each deploy — not from ancient history; without it (or when it is not below <head>) the parent.
  d=$(git rev-parse -q --verify "refs/tags/deployed^{commit}" 2>/dev/null || true)
  if [ -n "$d" ] && [ "$d" != "$head" ] && git merge-base --is-ancestor "$d" "$head"; then base=$d; else base=$parent; fi
  echo "hotfix-review-base: no completed main review found among the last $DEPTH first-parent commits — reviewing ${base:0:12}..${head:0:12} (deployed tag: ${d:-none})" >&2
fi
# a Review-Fix-Of: trailer in the range must name an ancestor (never trust a trailer that points elsewhere)
for c in $(git rev-list "$base..$head"); do
  for t in $(git show -s --format=%B "$c" | sed -nE 's/^Review-Fix-Of: ([0-9a-f]{40})$/\1/p'); do
    if [ "$t" = "$c" ] || ! git merge-base --is-ancestor "$t" "$c" 2>/dev/null; then echo 'Review-Fix-Of must name an ancestor' >&2; exit 1; fi
  done
done
printf '%s\n' "$base"
