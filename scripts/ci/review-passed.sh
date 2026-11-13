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
list_runs() { # list_runs <status> → every Review run (one JSON object per line), all pages (not only the newest 100; cap 20 pages)
  local p r
  for p in $(seq 1 20); do
    r=$(gh api "repos/$repo/actions/workflows/review.yml/runs?event=workflow_run&branch=$BR&status=$1&per_page=100&page=$p" -q '.workflow_runs[] | tojson') || break
    [ -n "$r" ] || break
    printf '%s\n' "$r"
    [ "$(wc -l <<<"$r")" -ge 100 ] || break
  done
}
ids=$(list_runs success | jq -r --arg a "review $sha" --arg b "recheck $sha" 'select(.path == ".github/workflows/review.yml" and (.display_title == $a or .display_title == $b)) | .id')
# A workflow whose jobs were all skipped (CI failed, or not a push) still concludes
# "success": require the review job itself to have run its blocking step successfully.
attest_of_kind() { # attest_of_kind <run id> → "<head> <base> <kind>" (kind "review" when the artifact has none); 1 when no artifact
  local art tmpd
  art=$(gh api "repos/$repo/actions/runs/$1/artifacts" -q '.artifacts[] | select(.name == "review-attestation") | .id' | head -1)
  [ -n "$art" ] || return 1
  tmpd=$(mktemp -d); gh api "repos/$repo/actions/artifacts/$art/zip" > "$tmpd/a.zip" && (cd "$tmpd" && unzip -q a.zip)
  jq -r '"\(.head) \(.base) \(.kind // "review")"' "$tmpd/review-attestation.json"; rm -rf "$tmpd"
}
attest_of() { # attest_of <run id> → "<head> <base>" of its review-attestation artifact; 1 when it has none
  local art tmpd
  art=$(gh api "repos/$repo/actions/runs/$1/artifacts" -q '.artifacts[] | select(.name == "review-attestation") | .id' | head -1)
  [ -n "$art" ] || return 1
  tmpd=$(mktemp -d); gh api "repos/$repo/actions/artifacts/$art/zip" > "$tmpd/a.zip" && (cd "$tmpd" && unzip -q a.zip)
  jq -r '"\(.head) \(.base)"' "$tmpd/review-attestation.json"; rm -rf "$tmpd"
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
. "$(dirname "${BASH_SOURCE[0]}")/review-repair.sh"   # reverted / repaired: the one repair rule
completed_runs=""
covered() { # covered <base> <deployed> [depth]
  local b=$1 d=$2 n=${3:-0} id jobs st jid hb t log
  git merge-base --is-ancestor "$b" "$d" 2>/dev/null && return 0
  [ "$n" -lt 40 ] || return 1
  [ -n "$completed_runs" ] || completed_runs=$(list_runs completed)
  for id in $(jq -r --arg a "review $b" --arg r "recheck $b" 'select(.path == ".github/workflows/review.yml" and (.display_title == $a or .display_title == $r)) | .id' <<<"$completed_runs"); do
    jobs=$(gh api "repos/$repo/actions/runs/$id/jobs")
    st=$(jq -r '[.jobs[] | select(.name == "review") | .steps[] | select(.name | startswith("Review (blocking")) | .conclusion][0] // ""' <<<"$jobs")
    case "$st" in
      success) ;;
      failure)
        # a blocked round is a link only with the reviewer's verdict in its log (read whole first: grep -q closing a
        # pipe early made the upstream gh/sed die of SIGPIPE under pipefail) AND an effective repair of it in
        # <base>..<sha> — an unrepaired blocked commit is never vouched for by a later, unrelated review
        jid=$(jq -r '[.jobs[] | select(.name == "review")][0].id // empty' <<<"$jobs")
        [ -n "$jid" ] || continue
        log=$(gh api "repos/$repo/actions/jobs/$jid/logs" 2>/dev/null) || continue
        grep -qE '^([^ ]+ )?review-gate: BLOCKED #[0-9]+' <<<"$log" || continue
        repaired "$b" "$sha" || continue ;;
      *) continue ;;
    esac
    hb=$(attest_of "$id") || continue
    [ "${hb%% *}" = "$b" ] || continue
    covered "${hb#* }" "$d" $((n + 1)) && return 0
  done
  if [ "$(git rev-list --parents -n1 "$b" 2>/dev/null | wc -w)" = 3 ] \
     && t=$(git merge-tree --write-tree "$b^1" "$b^2" 2>/dev/null) && [ "${t%%$'\n'*}" = "$(git rev-parse "$b^{tree}")" ]; then
    covered "$(git rev-parse "$b^1")" "$d" $((n + 1)) && covered "$(git rev-parse "$b^2")" "$d" $((n + 1)) && return 0
  fi
  return 1
}
# Contract (CLAUDE.md "Shipping"): a run passes when its trusted `tests` job passed AND either
#   · its blocking review step "Review (blocking …" ran and succeeded (attestation kind "review", or none: older runs), or
#   · it is a TESTS-ONLY FIX round (owner: a dev fix lands on green tests without a second dev review): the blocking step
#     did not run (skipped), the attestation says kind "tests-only-fix", and — re-checked here from the trusted runs, not
#     taken from the candidate — every dev-side commit of base..sha is a Review-Fix-Of: repair of a commit whose own review
#     completed and blocked (dev-review-base.sh --only-fixes). Main then reviews those fixes with everything else (each
#     Train-Merge / hotfix re-check covers all commits since the last completed main review).
# A run whose review never ran for any other reason (cancelled, setup / gate failure) never passes.
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
      read -r ah ab _ <<<"$hb"
      [ "$ah" = "$sha" ] || { echo "run $id: attestation head mismatch" >&2; continue; }
      if ! (REPO=$repo bash "$(dirname "${BASH_SOURCE[0]}")/dev-review-base.sh" --only-fixes "$ab" "$sha" >/dev/null 2>&1); then
        echo "run $id: tests-only-fix round, but ${ab:0:12}..${sha:0:12} is not only repairs of completed (blocked) reviews" >&2; continue
      fi ;;
    *) continue ;;
  esac
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
      echo "prod ${3:0:12} is not an ancestor of ${sha:0:12}: deploying it would move prod backward or sideways" >&2; exit 1
    fi
    if ! covered "$base" "$3"; then
      # Coverage is about commits, including empty commits and both sides of renames.
      # Verification and deployment controls also require a trusted review.
      echo "reviewed range ${base:0:12}..${sha:0:12} does not cover prod ${3:0:12}" >&2
      exit 1
    fi
  fi
  echo "trusted tests + review passed for ${sha:0:12} (run $id)"; exit 0
done
echo "no successful trusted review for ${sha:0:12}" >&2
exit 1
