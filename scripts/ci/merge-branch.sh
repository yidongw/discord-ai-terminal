#!/usr/bin/env bash
# The merge path into main (owner 11-09: no PRs; push a branch, merge it once green).
#   GH_TOKEN=… scripts/ci/merge-branch.sh <branch> [<sha>]
# <sha> (dev merge-train): a reviewed commit of the branch that is not its head yet.
# Fast-forward only (the reviewed sha is exactly what lands on main), and only after
# scripts/ci/review-passed.sh confirms main's trusted tests + blocking review passed for that
# sha. A branch that disabled or renamed its CI never gets a review run, so it fails here.
# A tests-only fix round (review-passed.sh kind "tests-only-fix") lands only when main's review.yml will re-check it.
set -euo pipefail
MAIN=${MAIN_BRANCH:-main}
branch="${1:?usage: merge-branch.sh <branch>}"
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
git fetch -q origin "$MAIN" "$branch"
sha="$(git rev-parse "origin/$branch")"
if [ -n "${2:-}" ]; then
  sha="$(git rev-parse --verify "${2}^{commit}")"
  git merge-base --is-ancestor "$sha" "origin/$branch" || { echo "${sha:0:12} is not on origin/$branch" >&2; exit 1; }
fi
if ! git merge-base --is-ancestor origin/$MAIN "$sha"; then
  echo "origin/$branch is not a fast-forward of main: rebase it, push, and let CI + review run again" >&2
  exit 1
fi
kf=$(mktemp); trap 'rm -f "$kf"' EXIT
REVIEW_KIND_OUT=$kf bash "$here/review-passed.sh" "$sha" "${REPO:-yidongw/discord-ai-terminal}"
# A TESTS-ONLY approval (a fix round the dev reviewer did not read) is not a review: the fix may land only as a main head
# that review.yml re-checks — one carrying Review-Fix-Of: / Hotfix: / Train-Merge: (the main-review triggers there).
# Read the full message before matching: grep -q can close a pipe early and make git die of SIGPIPE under pipefail.
msg=$(git show -s --format=%B "$sha")
if [ "$(cat "$kf")" != review ] \
   && ! grep -qE '^(Review-Fix-Of: [0-9a-f]{40}|Hotfix: [^[:space:]]|Train-Merge: [0-9a-f]{40})' <<<"$msg"; then
  echo "${sha:0:12} has a tests-only approval and no Review-Fix-Of: / Hotfix: / Train-Merge: trailer: it would land on $MAIN without a main review — not merged" >&2
  exit 1
fi
git push origin "$sha:refs/heads/$MAIN"
echo "$MAIN → ${sha:0:12} ($branch)"
