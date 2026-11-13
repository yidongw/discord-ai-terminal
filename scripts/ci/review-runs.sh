#!/usr/bin/env bash
# THE provenance rule for a Review run used as evidence (sourced by dev-review-base.sh, hotfix-review-base.sh,
# review-passed.sh and prior-findings.sh — range selection, repair eligibility and approval read the same runs):
# a run counts only when GitHub started it from the default branch's .github/workflows/review.yml by a workflow_run
# event (event == "workflow_run", head_branch == the default branch, path == the workflow file). A branch can add its
# own workflow that is listed under review.yml with any title, job and step names — but only as a push / pull_request /
# … run of its own branch, never as a workflow_run run of the default branch. Titles and step names are read only
# from runs that pass this rule.
#
# The caller defines  review_api <path below repos/<owner>/<repo>/>  → the JSON answer on stdout, non-zero on failure.
REVIEW_BRANCH=${REVIEW_DEFAULT_BRANCH:-${MAIN_BRANCH:-main}}
REVIEW_TRUSTED_JQ='select(.event == "workflow_run" and .head_branch == $br and .path == ".github/workflows/review.yml")'

review_runs() { # review_runs [<status>] → the trusted Review runs, one JSON object per line, newest first; every page (cap 20)
  local p r n
  for p in $(seq 1 20); do
    r=$(review_api "actions/workflows/review.yml/runs?event=workflow_run&branch=$REVIEW_BRANCH${1:+&status=$1}&per_page=100&page=$p" 2>/dev/null) || break
    # the end of the list is decided on the page as the API returned it, never on what is left after filtering
    n=$(jq '.workflow_runs | length' <<<"$r" 2>/dev/null) || break
    [ "${n:-0}" -gt 0 ] || break
    jq -c --arg br "$REVIEW_BRANCH" ".workflow_runs[] | $REVIEW_TRUSTED_JQ" <<<"$r"
    [ "$n" -ge 100 ] || break
  done
  return 0
}

# Usable proof of a completed review = its run still has the review-attestation artifact (not expired: 90 days; not lost
# to a failed upload). review-passed.sh follows the coverage chain through these artifacts, so the range producers start
# a range only at a review that has one — otherwise they fall back to an older base (a larger range, provable again).
review_attested() { # review_attested <run id>
  local a
  a=$(review_api "actions/runs/$1/artifacts" 2>/dev/null) || return 1
  jq -e '[.artifacts[]? | select(.name == "review-attestation" and .expired != true)] | length > 0' <<<"$a" >/dev/null 2>&1
}
