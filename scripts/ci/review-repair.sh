#!/usr/bin/env bash
# THE eligibility rule for a blocked review round (sourced by dev-review-base.sh and review-passed.sh, owner 11-12:
# "没过，就修一次"): a round that BLOCKED at <S> counts — as a dev range base, as a link of deployment coverage — only
# when an effective repair of it is an ancestor of the head being judged: a commit in <S>..<head> carrying the exact
# trailer "Review-Fix-Of: <S>" (full sha) that is not reverted since. Otherwise S's code is not vouched for by any later,
# unrelated review. (review-dispatch.sh's repair_effective is the dispatcher's richer form of the same rule.)
reverted() { # reverted <c> <head> [depth] → 0 when a standing "This reverts commit <c>" sits in c..head (fail closed past 64)
  local x k=${3:-0}
  [ "$k" -lt 64 ] || return 0
  for x in $(git log --format=%H -F --grep="This reverts commit $1" "$1..$2" 2>/dev/null || true); do
    reverted "$x" "$2" $((k + 1)) || return 0   # x stands → c is reverted
  done
  return 1
}
repaired() { # repaired <S> <head> → 0 when S..head carries an effective repair of S
  local c
  for c in $(git log --format=%H -F --grep="Review-Fix-Of: $1" "$1..$2" 2>/dev/null || true); do
    git show -s --format=%B "$c" | grep -qx "Review-Fix-Of: $1" || continue
    reverted "$c" "$2" || return 0
  done
  return 1
}
