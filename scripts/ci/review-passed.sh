#!/usr/bin/env bash
# Exit 0 iff the trusted blocking review passed for <sha>: a successful run of
# .github/workflows/review.yml that GitHub started from main by a workflow_run event, titled
# "review <sha>", whose trusted `tests` job passed and whose review job actually ran its
# blocking step successfully. A branch
# cannot create such a run (its own workflows run on push, from its
# branch), so unlike the review/blocking commit status this cannot be forged.
#   GH_TOKEN=… scripts/ci/review-passed.sh <full-sha> [owner/repo] [deployed-sha]
# [owner/repo] defaults to $REPO, then yidongw/discord-ai-terminal; the default branch to
# $REVIEW_DEFAULT_BRANCH, then $MAIN_BRANCH, then main.
# With [deployed-sha] (the controller passes prod's current sha) it also requires that the
# reviewed range covers everything new to prod: the run's attestation base must be an ancestor
# of (or equal to) deployed-sha, so no commit pushed to main outside the review rides along.
# Needs a local clone in the current directory for the ancestry check.
set -euo pipefail
sha="${1:?usage: review-passed.sh <full-sha> [owner/repo]}"
repo="${2:-${REPO:-yidongw/discord-ai-terminal}}"
[[ "$sha" =~ ^[0-9a-f]{40}$ ]] || { echo "need a full sha" >&2; exit 2; }
BR=${REVIEW_DEFAULT_BRANCH:-${MAIN_BRANCH:-main}}
review_api() { gh api "repos/$repo/$1"; }
REVIEW_DEFAULT_BRANCH=$BR
. "$(dirname "${BASH_SOURCE[0]}")/review-runs.sh"   # review_runs: the one provenance rule, every page (not only the newest 100)
list_runs() { review_runs "$1"; }
ids=$(list_runs success | jq -r --arg a "review $sha" --arg b "recheck $sha" 'select(.display_title == $a or .display_title == $b) | .id')
# A workflow whose jobs were all skipped (CI failed, or not a push) still concludes
# "success": require the review job itself to have run its blocking step successfully.
attest_of_kind() { # attest_of_kind <run id> → "<head> <base> <main at review time, or -> <kind>" (kind "review" when the artifact has none); 1 when no usable artifact
  local art tmpd
  # sed prints the first result while draining the producer (head can cause SIGPIPE under pipefail).
  art=$(gh api "repos/$repo/actions/runs/$1/artifacts" -q '.artifacts[] | select(.name == "review-attestation" and .expired != true) | .id' | sed -n '1p')
  [ -n "$art" ] || return 1
  tmpd=$(mktemp -d); gh api "repos/$repo/actions/artifacts/$art/zip" > "$tmpd/a.zip" && (cd "$tmpd" && unzip -q a.zip)
  jq -r '"\(.head) \(.base) \(.main // "-") \(.kind // "review")"' "$tmpd/review-attestation.json"; rm -rf "$tmpd"
}
# Coverage by a chain of completed rounds (dev reviews cover only what no completed review covered, owner 11-12):
# <base> is covered when it is an ancestor of (or equal to) <deployed>; or a completed review of <base> itself
# ("review <base>" / "recheck <base>" from main's workflow whose blocking step ran to a verdict: success, or failure WITH
# the reviewer's "review-gate: BLOCKED" verdict in its log — a crash or setup failure reviewed nothing — and an effective
# repair of <base> between it and <sha>: an unrepaired blocked round never links) attests a range
# whose base is covered in turn; or <base> is a clean merge (its tree is exactly the automatic merge of its two
# parents) and BOTH parents are covered (a main hotfix merged into dev is covered only by its own review chain, never by
# the dev side's). Every link is a trusted run of this workflow; nothing is taken from the candidate. Fail closed past
# 40 links.
. "$(dirname "${BASH_SOURCE[0]}")/review-coverage.sh"
covered() { review_covered "$1" "$2" "$sha" "${3:-0}"; }
# Contract (CLAUDE.md "Shipping"): a run passes when its trusted `tests` job passed AND either
#   · its blocking review step "Review (blocking …" ran and succeeded (attestation kind "review", or none: older runs), or
#   · it is a TESTS-ONLY FIX round (owner: a dev fix lands on green tests without a second dev review): the blocking step
#     did not run (skipped), the attestation says kind "tests-only-fix", and — re-checked here from the trusted runs, not
#     taken from the candidate — every dev-side commit of base..sha is a Review-Fix-Of: repair of a commit whose own review
#     completed and blocked (dev-review-base.sh --only-fixes, against the main boundary the attestation recorded at
#     review time, so the answer holds after main advanced onto the fix). Main then reviews the fix: its head carries
#     Review-Fix-Of:, which starts a main re-check when it lands (review.yml), over all commits since the last completed
#     main review.
# A run whose review never ran for any other reason (cancelled, setup / gate failure) never passes.
# REVIEW_KIND_OUT=<file>: the kind of the approving run ("review" | "tests-only-fix") is written there (merge-branch.sh).
for id in $ids; do
  jobs=$(gh api "repos/$repo/actions/runs/$id/jobs")
  tests=$(jq '[.jobs[] | select(.name == "tests" and .conclusion == "success")] | length' <<<"$jobs")
  [ "${tests:-0}" -gt 0 ] || continue
  [ "$(jq '[.jobs[] | select(.name == "review" and .conclusion == "success")] | length' <<<"$jobs")" -gt 0 ] || continue
  st=$(jq -r '[.jobs[] | select(.name == "review") | .steps[] | select(.name | startswith("Review (blocking")) | .conclusion][0] // ""' <<<"$jobs")
  hb=$(attest_of_kind "$id") || hb=""
  kind=${hb##* }
  case "$st" in
    success) [ "$kind" = tests-only-fix ] && { echo "run $id: a tests-only-fix attestation on a reviewed step" >&2; continue; } ;;
    skipped)
      [ "$kind" = tests-only-fix ] || continue
      read -r ah ab am _ <<<"$hb"
      [ "$ah" = "$sha" ] || { echo "run $id: attestation head mismatch" >&2; continue; }
      # A historical tests-only approval needs its recorded boundary. Legacy or malformed
      # metadata must be rerun; consulting today's main would change the answer after landing.
      [[ "$am" =~ ^[0-9a-f]{40}$ ]] || { echo "run $id: no immutable main boundary; rerun review" >&2; continue; }
      git rev-parse -q --verify "$am^{commit}" >/dev/null 2>&1 || { echo "run $id: attested main ${am:0:12} is not in this clone" >&2; continue; }
      mref=$am
      if ! (REPO=$repo DEV_REVIEW_MAIN_REF=$mref bash "$(dirname "${BASH_SOURCE[0]}")/dev-review-base.sh" --only-fixes "$ab" "$sha" >/dev/null 2>&1); then
        echo "run $id: tests-only-fix round, but ${ab:0:12}..${sha:0:12} is not only repairs of completed (blocked) reviews" >&2; continue
      fi ;;
    *) continue ;;
  esac
  if [ -n "${3:-}" ]; then
    art=$(gh api "repos/$repo/actions/runs/$id/artifacts" -q '.artifacts[] | select(.name == "review-attestation" and .expired != true) | .id' | sed -n '1p')
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
      echo "prod ${3:0:12} is not an ancestor of ${sha:0:12}: deploying it would move prod backward or sideways" >&2; exit 1
    fi
    if ! covered "$base" "$3"; then
      # Coverage is about commits, including empty commits and both sides of renames.
      # Verification and deployment controls also require a trusted review.
      # Not the end: another successful run of this sha (an older full-range one) may still prove the coverage.
      echo "run $id: reviewed range ${base:0:12}..${sha:0:12} does not cover prod ${3:0:12}" >&2
      continue
    fi
  fi
  [ -z "${REVIEW_KIND_OUT:-}" ] || { [ "$st" = skipped ] && echo tests-only-fix || echo review; } > "$REVIEW_KIND_OUT"
  echo "trusted tests + review passed for ${sha:0:12} (run $id)"; exit 0
done
echo "no successful trusted review for ${sha:0:12}" >&2
exit 1
