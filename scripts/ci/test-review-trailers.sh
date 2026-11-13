#!/usr/bin/env bash
# Regression: a matching trailer near the start of a long message must not cause
# git show | grep -q to fail with SIGPIPE under pipefail. No network or Node dependencies.
set -euo pipefail
CI=$(cd "$(dirname "$0")" && pwd); ROOT=$(cd "$CI/../.." && pwd)
T=$(mktemp -d); trap 'rm -rf "$T"' EXIT
FAILS=0
check() {
  local want=$1 label=$2 status=0; shift 2
  "$@" >"$T/check.log" 2>&1 || status=$?
  if { [ "$want" = accept ] && [ "$status" = 0 ]; } || { [ "$want" = reject ] && [ "$status" != 0 ]; }; then
    echo "ok: $label"
  else
    echo "FAIL: $label (expected $want, exit $status)" >&2
    cat "$T/check.log" >&2
    FAILS=$((FAILS + 1))
  fi
}

git init -q -b main "$T/candidate"
cd "$T/candidate"
git config user.name test; git config user.email test@example.invalid
git -c core.hooksPath=/dev/null commit -q --allow-empty -m base
S=$(git rev-parse HEAD)
git init -q --bare "$T/remote.git"
git remote add origin "$T/remote.git"
git push -q origin "$S:refs/heads/main"
mkdir -p "$T/merge" "$T/.trusted/scripts/ci"
cp "$CI/merge-branch.sh" "$T/merge/"
# Approval itself is exercised by test-review-contract.sh; isolate the merge trailer guard here.
cat > "$T/merge/review-passed.sh" <<'SH'
echo tests-only-fix > "$REVIEW_KIND_OUT"
SH
cat > "$T/.trusted/scripts/ci/hotfix-review-base.sh" <<'SH'
git rev-parse HEAD^
SH

# Extract the actual workflow shell block (stdlib only: the tests VM has no PyYAML).
# Fail if its shape changes, rather than silently testing a copied version of the guard.
python3 - "$ROOT/.github/workflows/review.yml" "$T/range.sh" <<'PY'
import pathlib, sys, textwrap
lines = pathlib.Path(sys.argv[1]).read_text().splitlines(keepends=True)
start = lines.index('      - name: Reviewed range\n') + 1
while lines[start] != '        run: |\n':
    assert not lines[start].startswith('      - '), 'Reviewed range run block not found'
    start += 1
end = start + 1
while end < len(lines) and (lines[end].startswith('          ') or not lines[end].strip()):
    end += 1
script = textwrap.dedent(''.join(lines[start + 1:end]))
assert '${{ github.event.workflow_run.head_branch }}' in script
script = script.replace('${{ github.event.workflow_run.head_branch }}', 'main')
assert '${{' not in script, 'unhandled workflow expression'
pathlib.Path(sys.argv[2]).write_text(script)
PY
export GITHUB_ENV=$T/env GITHUB_OUTPUT=$T/output
range_step() {
  git checkout -q --detach "$1"
  : > "$GITHUB_ENV"; : > "$GITHUB_OUTPUT"
  bash -e -o pipefail "$T/range.sh"
}
land() {
  git push -q -f origin "$S:refs/heads/main" "$1:refs/heads/dev"
  bash "$T/merge/merge-branch.sh" dev "$1"
}
repair() {
  bash -euo pipefail -c 'source "$1/review-repair.sh"; repaired "$2" "$3"' _ "$CI" "$S" "$1"
}
long_commit() { # long_commit <trailer> <early|late>
  python3 - "$1" "$2" > "$T/message" <<'PY'
import sys
trailer, position = sys.argv[1:]
padding = ('x' * 99 + '\n') * 20000  # 2 MB, far beyond the pipe buffer
print('long message\n')
print(trailer + '\n\n' + padding if position == 'early' else padding + '\n' + trailer)
PY
  git -c core.hooksPath=/dev/null commit -q --allow-empty -F "$T/message"
  git rev-parse HEAD
}

for position in early late; do
  for kind in Review-Fix-Of Hotfix Train-Merge; do
    git checkout -q --detach "$S"
    value=$S; [ "$kind" != Hotfix ] || value='long-message repair'
    F=$(long_commit "$kind: $value" "$position")
    check accept "$kind $position: workflow range" range_step "$F"
    check accept "$kind $position: tests-only merge" land "$F"
    [ "$(git ls-remote origin refs/heads/main | cut -f1)" = "$F" ] || { echo 'FAIL: merge did not land' >&2; FAILS=$((FAILS + 1)); }
    if [ "$kind" = Review-Fix-Of ]; then
      check accept "repair $position: effective repair" repair "$F"
      git -c core.hooksPath=/dev/null commit -q --allow-empty -m "revert repair" -m "This reverts commit $F."
      R=$(git rev-parse HEAD)
      check reject "repair $position: reverted repair" repair "$R"
      git -c core.hooksPath=/dev/null commit -q --allow-empty -m "restore repair" -m "This reverts commit $R."
      check accept "repair $position: restored repair" repair HEAD
    fi
  done
done

# Missing trailers still fail closed, and a substring is not the exact repair trailer.
git checkout -q --detach "$S"
N=$(long_commit 'no review trailer here' early)
check reject 'missing trailer: workflow range' range_step "$N"
check reject 'missing trailer: tests-only merge' land "$N"
[ "$(git ls-remote origin refs/heads/main | cut -f1)" = "$S" ] || { echo 'FAIL: rejected merge moved main' >&2; FAILS=$((FAILS + 1)); }
check reject 'missing trailer: effective repair' repair "$N"
N=$(long_commit "quoted Review-Fix-Of: $S" early)
check reject 'substring trailer: effective repair' repair "$N"
[ "$FAILS" = 0 ] || { echo "$FAILS trailer check(s) failed" >&2; exit 1; }
echo 'all trailer checks passed'
