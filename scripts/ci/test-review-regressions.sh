#!/usr/bin/env bash
# Security/coverage regressions for main review 9591f3cbe. No network or project dependencies.
set -uo pipefail
. "$(dirname "${BASH_SOURCE[0]}")/test-review-fixtures.sh"

dbase() { bash "$CI/dev-review-base.sh" "$@" 2>"$T/err"; }
mbase() { bash "$CI/hotfix-review-base.sh" "$@" 2>"$T/err"; }
regression() {
  local finding=$1 p a b s f
  p=$(c prod); git update-ref refs/remotes/origin/main "$p"; git tag -f deployed "$p" >/dev/null
  case "$finding" in
    3)
      s=$(c change); f=$(c fix "Review-Fix-Of: $s")
      reset; run 3 "review $s" success failure "$p" "" blocked; run 4 "review $f" success skipped "$s" tests-only-fix
      RP "$f" o/r "$p" || fail "#3 initial fix approval failed: $(cat "$T/err")"
      git update-ref refs/remotes/origin/main "$f"
      RP "$f" o/r "$p" || fail "#3 identical historical approval broke when origin/main advanced: $(cat "$T/err")"
      # Without metadata the old fallback accepted at P and rejected at F. Require a rerun at either ref.
      git update-ref refs/remotes/origin/main "$p"
      jq 'del(.main)' "$FX/attest-4.json" > "$FX/tmp"; mv "$FX/tmp" "$FX/attest-4.json"
      RP "$f" o/r "$p" && fail "#3 legacy tests-only attestation without boundary accepted"
      ;;
    4)
      a=$(c a); b=$(c b)
      reset; run 1 "review $a" success success "$p"; rm "$FX/attest-1.json"
      [ "$(dbase "$b")" = "$p" ] || fail "#4 dev advanced past a review without an artifact"
      run 2 "recheck $a" success success "$p"; rm "$FX/attest-2.json"
      [ "$(mbase "$b")" = "$p" ] || fail "#4 main advanced past a review without an artifact"
      run 3 "review $b" success success "$(dbase "$b")"
      RP "$b" o/r "$p" || fail "#4 fallback review cannot prove coverage"
      # An artifact for A is insufficient when its predecessor's proof has expired.
      s=$(c next); reset; run 1 "review $a" success success "$p"; run 2 "review $b" success success "$a"
      rm "$FX/attest-1.json"
      [ "$(dbase "$s")" = "$p" ] || fail "#4 dev used an incomplete predecessor chain"
      reset; run 1 "recheck $a" success success "$p"; run 2 "recheck $b" success success "$a"; rm "$FX/attest-1.json"
      [ "$(mbase "$s")" = "$p" ] || fail "#4 main used an incomplete predecessor chain"
      # A clean main-to-dev merge may advance the diff base only if both sides have usable proof.
      g checkout -q --detach "$a"; local dev_head main_head merge_head candidate
      dev_head=$(c dev "" devfile)
      g checkout -q --detach "$p"; main_head=$(c main "" mainfile)
      git update-ref refs/remotes/origin/main "$main_head"
      g checkout -q --detach "$dev_head"; g merge -q --no-ff -m merge "$main_head"
      merge_head=$(git rev-parse HEAD); candidate=$(c next "" devfile)
      reset; run 1 "review $dev_head" success success "$p"
      [ "$(dbase --diff "$dev_head" "$candidate")" = "$dev_head" ] || fail "#4 diff advanced over a merge with missing main-side proof"
      run 2 "recheck $main_head" success success "$p"
      [ "$(dbase --diff "$dev_head" "$candidate")" = "$merge_head" ] || fail "#4 diff did not advance over a proven clean merge"
      run 3 "review $candidate" success success "$merge_head"
      RP "$candidate" o/r "$p" || fail "#4 clean-merge diff base not usable by consumer"
      ;;
    *) fail "unsupported finding $finding" ;;
  esac
  echo "ok finding #$finding"
}
if [ "${1:-}" = --finding ]; then
  regression "${2:?finding number}"; exit
fi
for finding in 3 4; do
  bash "$CI/test-review-regressions.sh" --finding "$finding" || exit 1
done

