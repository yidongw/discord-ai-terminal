#!/usr/bin/env bash
# The reviewed range of a dev review (owner 11-12: "dev 上审查一次。没过，就修一次，CI 过了直接合进 main，不再审第二次";
# "每个提交只审一次"). Mirrors main's scripts/ci/hotfix-review-base.sh: each dev commit is reviewed once — the next dev
# review covers only what no completed review has covered yet, and a range of only fixes of earlier blocked reviews is
# not reviewed again (its trusted tests still run and decide). Before 11-13 every dev round reviewed
# merge-base(main)..dev again: blocked, fixed, and the next round found something new in the same 38 commits.
#
# A review COMPLETED when the blocking step of its run ("review <sha>"; review.yml's step "Review (blocking …") ran to a
# verdict: success = passed (or a skipped fix range); failure = blocked ONLY when the job log carries the reviewer's
# "review-gate: BLOCKED #n" verdict. A cancelled / skipped review job, a failed setup or commit gate, a timeout, a reviewer
# crash or an unreadable verdict reviewed nothing: those commits stay in the range, and a Review-Fix-Of: naming such a
# commit is no fix. Run lookups read every page of Review runs (not only the newest 100), and only TRUSTED runs
# (review-runs.sh: started from main's review.yml by workflow_run — a branch's own run with the same title is ignored).
# A review is a range base only while its attestation artifact is usable (review-passed.sh's chain needs it); one without
# is passed over, so the range grows back to a base the approval consumer can prove.
#
#   dev-review-base.sh [<head>]
#     → the cover base: the newest first-parent ancestor C of <head> (not <head> itself) whose dev review completed and
#       either PASSED, or BLOCKED and C..<head> carries an effective repair of C (a commit with "Review-Fix-Of: C" that
#       is not reverted). A blocked C without its repair is passed over, and from then on the base may be no newer
#       than the base C's own review used (its "review-range:" line): C's whole range is reviewed again together with
#       the new commits — a blocked commit never lands on an unrelated commit's review, whatever was repaired above it.
#       The walk stops at main; nothing qualifies (or the API fails) → merge-base(origin/main, <head>), or the older
#       limit a passed-over blocked review set.
#   dev-review-base.sh --diff <cover base> <head>
#     → the base to diff against: the cover base moved past clean main→dev merges right above it (their main side was
#       reviewed on main), mirroring main's move past dev train merges. A real, published commit.
#   dev-review-base.sh --only-fixes <cover base> <head>
#     → exit 0 when every dev-side non-merge commit of base..head (at least one; commits on main are main's) is a fix
#       of an earlier BLOCKED review: a Review-Fix-Of: target T that is an ancestor of the fix
#       AND has a completed review run that blocked ("review T" / "recheck T", blocking step failure — the Review
#       runs are the evidence, not the candidate's trailer); and every dev-side merge in the range is clean (its tree is
#       exactly the automatic merge of its two parents: no code of its own), and no dev commit in OR BELOW the range
#       (down to main; merges included) is a blocked, unrepaired review (that one is reviewed again). review.yml does not review such a range
#       again (REVIEW_SKIP); review-passed.sh counts the run as passed when its tests pass.
#
# "main" is DEV_REVIEW_MAIN_REF (default origin/main). review.yml pins it to the sha origin/main had at review time and
# records it in the attestation ("main"); review-passed.sh re-checks a tests-only round against that same boundary, so
# the answer does not change when main later advances onto the approved fix.
#
# Run in the candidate checkout (full history, origin/main present). GH_TOKEN (actions: read), REPO.
set -euo pipefail
MAINREF=${DEV_REVIEW_MAIN_REF:-origin/main}
REPO=${REPO:-${GITHUB_REPOSITORY:-yidongw/discord-ai-terminal}}
API=${GITHUB_API_URL:-https://api.github.com}
DEPTH=${REVIEW_BASE_DEPTH:-80}
api() { curl -fsSL -m 30 -H "Authorization: Bearer ${GH_TOKEN:-}" -H "Accept: application/vnd.github+json" "$API/repos/$REPO/$1"; }
review_api() { api "$1"; }
. "$(dirname "${BASH_SOURCE[0]}")/review-runs.sh"   # review_runs / review_attested: the one provenance rule
. "$(dirname "${BASH_SOURCE[0]}")/review-coverage.sh"

runs=""   # "<sha> <run id>" of the trusted "review <sha>" / "recheck <sha>" runs (the API lists newest first; every page)
load_runs() {
  runs=$(review_runs | jq -r 'select(.display_title | test("^(review|recheck) [0-9a-f]{40}$")) | "\(.display_title | sub("^[a-z]+ "; "")) \(.id)"')
}
verdict() { # verdict <sha> → "pass <run id>" | "blocked <base its review used, or -> <run id>" of its newest completed review; "" when none
  # completed = the blocking step ran to a verdict: success, or failure WITH the reviewer's "review-gate: BLOCKED #n"
  # verdict in its log. A crash, an unreadable verdict, a failed setup / commit gate reviewed nothing: not completed.
  local id jobs st jid log rb
  for id in $(awk -v c="$1" '$1 == c { print $2 }' <<<"$runs"); do
    jobs=$(api "actions/runs/$id/jobs" 2>/dev/null || true)
    st=$(jq -r '[.jobs[]? | select(.name == "review") | .steps[]? | select(.name | startswith("Review (blocking")) | .conclusion][0] // ""' <<<"$jobs" 2>/dev/null || true)
    case "$st" in
      success) echo "pass $id"; return ;;
      failure)
        jid=$(jq -r '[.jobs[]? | select(.name == "review")][0].id // empty' <<<"$jobs" 2>/dev/null || true)
        [ -n "$jid" ] || continue
        log=$(api "actions/jobs/$jid/logs" 2>/dev/null | sed -E 's/^[^ ]+ //' || true)
        grep -qE '^review-gate: BLOCKED #[0-9]+' <<<"$log" || continue
        rb=$(sed -nE 's/^review-range: ([0-9a-f]{40}) [0-9a-f]{40}$/\1/p' <<<"$log"); rb=${rb%%$'\n'*}   # no head: an early-closed pipe dies of SIGPIPE under pipefail
        echo "blocked ${rb:--} $id"; return ;;
    esac
  done
}
. "$(dirname "${BASH_SOURCE[0]}")/review-repair.sh"   # reverted / repaired: the one repair rule
clean_merge() { # clean_merge <m> → 0 when m has two parents and its tree is exactly their automatic merge
  local t
  [ "$(git rev-list --parents -n1 "$1" | wc -w)" = 3 ] || return 1
  t=$(git merge-tree --write-tree "$1^1" "$1^2" 2>/dev/null) || return 1
  [ "${t%%$'\n'*}" = "$(git rev-parse "$1^{tree}")" ]
}

only_fixes() { # only_fixes <base> <head>
  local c t n=0 hit v
  # a tests-only round ends at a fix commit: its Review-Fix-Of: trailer is what starts the main re-check when it
  # lands (review.yml), so a range whose head is a merge is reviewed normally
  [ "$(git rev-list --parents -n1 "$2" | wc -w)" = 2 ] || return 1
  [ -n "$runs" ] || load_runs
  # no blocked, unrepaired review in or below the range (down to main), merges included: that one is reviewed again
  for c in $(git rev-list "$2" "^$MAINREF"); do
    v=$(verdict "$c")
    if [ "${v%% *}" = blocked ] && ! repaired "$c" "$2"; then return 1; fi
  done
  for c in $(git rev-list --merges "$1..$2" "^$MAINREF"); do clean_merge "$c" || return 1; done
  for c in $(git rev-list --no-merges "$1..$2" "^$MAINREF"); do
    hit=0
    for t in $(git show -s --format=%B "$c" | sed -nE 's/^Review-Fix-Of: ([0-9a-f]{40})[[:space:]]*$/\1/p'); do
      git rev-parse -q --verify "$t^{commit}" >/dev/null 2>&1 || continue
      [ "$t" != "$c" ] && git merge-base --is-ancestor "$t" "$c" 2>/dev/null || continue
      v=$(verdict "$t")
      if [ "${v%% *}" = blocked ]; then hit=1; break; fi
    done
    [ "$hit" = 1 ] || return 1
    n=$((n + 1))
  done
  [ "$n" -gt 0 ]
}

diff_base() { # diff_base <cover base> <head>
  local b=$1 h=$2 n
  while n=$(git rev-list --first-parent --reverse "$b..$h" | sed -n '1p') && [ -n "$n" ] && [ "$n" != "$h" ]; do
    clean_merge "$n" && git merge-base --is-ancestor "$n^2" "$MAINREF" 2>/dev/null || break
    review_covered "$n" "$b" "$h" || break
    b=$n
  done
  printf '%s\n' "$b"
}

case "${1:-}" in
  --only-fixes) only_fixes "$(git rev-parse "$2^{commit}")" "$(git rev-parse "$3^{commit}")"; exit ;;
  --diff) diff_base "$(git rev-parse "$2^{commit}")" "$(git rev-parse "$3^{commit}")"; exit ;;
esac

head=$(git rev-parse "${1:-HEAD}^{commit}")
mb=$(git merge-base "$MAINREF" "$head")
base=""
limit=""   # passing over a blocked, unrepaired R: the base may be no newer than the base R's own review used
if parent=$(git rev-parse -q --verify "$head^1^{commit}") && ! git merge-base --is-ancestor "$parent" "$mb"; then
  load_runs
  if [ -n "$runs" ]; then
    for c in $(git rev-list --first-parent -n "$DEPTH" "$parent"); do
      git merge-base --is-ancestor "$c" "$mb" && break   # reached main
      v=$(verdict "$c")
      case "${v%% *}" in
        pass|blocked)
          if [ "${v%% *}" = pass ] || repaired "$c" "$head"; then
            if ! review_link "${v##* }" "$c" "$mb" "$head" 0; then
              echo "dev-review-base: the review of ${c:0:12} (run ${v##* }) has no usable coverage chain — not a base, its commits are reviewed again" >&2
              continue
            fi
            if [ -z "$limit" ] || git merge-base --is-ancestor "$c" "$limit"; then base=$c; break; fi
            continue
          fi
          s=${v#blocked }; s=${s%% *}
          if [ "$s" = - ] || ! git merge-base --is-ancestor "$s" "$c" 2>/dev/null; then s=$mb; fi
          if [ -z "$limit" ]; then limit=$s; else limit=$(git merge-base "$limit" "$s"); fi
          echo "dev-review-base: ${c:0:12} was blocked and is not repaired in ${c:0:12}..${head:0:12} — its range (from ${s:0:12}) is reviewed again" >&2 ;;
      esac
    done
  fi
fi
if [ -z "$base" ]; then
  base=$mb
  if [ -n "$limit" ]; then base=$(git merge-base "$mb" "$limit"); fi
  echo "dev-review-base: no completed dev review to start from — reviewing ${base:0:12}..${head:0:12}" >&2
fi
printf '%s\n' "$base"
