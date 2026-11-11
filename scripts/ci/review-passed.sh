#!/usr/bin/env bash
# Exit 0 iff the trusted blocking review passed for <sha>: a successful run of
# .github/workflows/review.yml that GitHub started from main by a workflow_run event, titled
# "review <sha>", whose trusted `tests` job passed and whose review job actually ran its
# blocking step successfully. A branch
# cannot create such a run (its own workflows run on push, from its
# branch), so unlike the review/blocking commit status this cannot be forged.
#   GH_TOKEN=… scripts/ci/review-passed.sh <full-sha> [owner/repo] [deployed-sha]
# With [deployed-sha] (the controller passes prod's current sha) it also requires that the
# reviewed range covers everything new to prod: the run's attestation base must be an ancestor
# of (or equal to) deployed-sha, so no commit pushed to main outside the review rides along.
# Needs a local clone in the current directory for the ancestry check.
set -euo pipefail
sha="${1:?usage: review-passed.sh <full-sha> [owner/repo]}"
repo="${2:-${REPO:-yidongw/discord-ai-terminal}}"
[[ "$sha" =~ ^[0-9a-f]{40}$ ]] || { echo "need a full sha" >&2; exit 2; }
# Every page (an approval stays findable however many runs follow it), newest first.
ids=$(gh api --paginate "repos/$repo/actions/workflows/review.yml/runs?event=workflow_run&branch=${REVIEW_DEFAULT_BRANCH:-main}&status=success&per_page=100" \
  -q ".workflow_runs[] | select(.path == \".github/workflows/review.yml\" and (.display_title == \"review $sha\" or .display_title == \"recheck $sha\")) | .id")
# A workflow whose jobs were all skipped (CI failed, or not a push) still concludes
# "success": require the review job itself to have run its blocking step successfully.
for id in $ids; do
  jobs=$(gh api "repos/$repo/actions/runs/$id/jobs")
  tests=$(jq '[.jobs[] | select(.name == "tests" and .conclusion == "success")] | length' <<<"$jobs")
  rev=$(jq '[.jobs[] | select(.name == "review" and .conclusion == "success")
          | .steps[] | select((.name | startswith("Review (blocking")) and .conclusion == "success")] | length' <<<"$jobs")
  if [ "${tests:-0}" -gt 0 ] && [ "${rev:-0}" -gt 0 ]; then
    if [ -n "${3:-}" ]; then
      art=$(gh api "repos/$repo/actions/runs/$id/artifacts" -q '.artifacts[] | select(.name == "review-attestation") | .id' | head -1)
      # Runs made before the attestation step existed (review.yml before this change) carry no
      # artifact, so their reviewed range cannot be proven: never auto-deployable. That is a
      # one-time bootstrap: the commit that introduces the attestation is deployed by hand
      # (DEPLOY_PULL_SHA on prod, under supervision); every later review carries the artifact.
      [ -n "$art" ] || { echo "run $id predates review attestations: not auto-deployable (deploy by hand once)" >&2; continue; }
      tmpd=$(mktemp -d); gh api "repos/$repo/actions/artifacts/$art/zip" > "$tmpd/a.zip" && (cd "$tmpd" && unzip -q a.zip)
      base=$(jq -r .base "$tmpd/review-attestation.json"); head=$(jq -r .head "$tmpd/review-attestation.json"); rm -rf "$tmpd"
      [ "$head" = "$sha" ] || { echo "attestation head mismatch" >&2; continue; }
      # REVIEW_MERGE_INTO=1 (autodeploy, train merge): $3 is the merge's main-side parent, which
      # need not be an ancestor of sha; the range check below still applies.
      if [ "${REVIEW_MERGE_INTO:-0}" != 1 ] && ! git merge-base --is-ancestor "$3" "$sha"; then
        echo "prod ${3:0:12} is not an ancestor of ${sha:0:12}: deploying it would move prod backward or sideways" >&2; exit 1   # a property of the shas, not of the run
      fi
      if ! git merge-base --is-ancestor "$base" "$3"; then
        echo "run $id: reviewed range ${base:0:12}..${sha:0:12} does not cover ${3:0:12}" >&2; continue   # an older run of the same sha may
      fi
    fi
    echo "trusted tests + review passed for ${sha:0:12} (run $id)"; exit 0
  fi
done
echo "no successful trusted review for ${sha:0:12}" >&2
exit 1
