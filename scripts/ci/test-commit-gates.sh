#!/usr/bin/env bash
# Offline regression for main finding #0 on 372b9d3b3. The trusted gate and
# candidate live in separate directories, as they do in review.yml.
set -euo pipefail
CI=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
T=$(mktemp -d); trap 'rm -rf "$T"' EXIT
mkdir -p "$T/trusted/commit-verification"
cp "$CI/commit-gates.sh" "$T/trusted/commit-gates.sh"
git init -q -b main "$T/candidate"; cd "$T/candidate"
g() { git -c user.name=test -c user.email=test@example.invalid "$@"; }
fail() { echo "FAIL: $*" >&2; exit 1; }
trailers=$'Loop: test\nThread: mcp:00000000-0000-0000-0000-000000000000'
checked=$'Verify:\n- [x] fixture verification'
commit() { g commit -q --allow-empty -m fixture -m "$1"; git rev-parse HEAD; }
base=$(commit "$trailers
$checked")
expect() {
  local want=$1 label=$2 got=0
  bash "$T/trusted/commit-gates.sh" "$base" HEAD > "$T/out" 2>&1 || got=$?
  if [ "$got" != "$want" ]; then cat "$T/out" >&2; fail "$label: expected $want, got $got"; fi
}
record() { printf 'Commit: %s\n%s\n' "$1" "$checked" > "$T/trusted/commit-verification/$1.txt"; }

commit "$trailers
$checked" >/dev/null
expect 0 'ordinary valid commit'
g checkout -q --detach "$base"
bad=$(commit "$trailers
Verify:")
expect 3 'empty Verify must fail'

# Candidate-controlled files and repair trailers do not supply trusted evidence.
mkdir -p scripts/ci/commit-verification
printf 'Commit: %s\n%s\n' "$bad" "$checked" > "scripts/ci/commit-verification/$bad.txt"
expect 3 'candidate record must be ignored'
commit "$trailers
Review-Fix-Of: $bad
$checked" >/dev/null
expect 3 'follow-up checklist cannot implicitly waive its parent'
g checkout -q --detach "$bad"

# A trusted record must match this exact SHA and carry the normal checklist.
evidence="$T/trusted/commit-verification/$bad.txt"
printf 'Commit: %040d\n%s\n' 0 "$checked" > "$evidence"
expect 3 'mismatched Commit header'
for invalid in 'Verify: inline evidence' $'Verify:\n- [ ] NOT RUN: fixture' $'Verify:\n\n- [x] not adjacent'; do
  printf 'Commit: %s\n%s\n' "$bad" "$invalid" > "$evidence"
  expect 3 'malformed supplemental checklist'
done
record "$bad"
expect 0 'trusted exact-SHA checklist repairs immutable metadata'
grep -q 'supplemental Verify checklist from trusted' "$T/out" || fail 'supplement not logged'
commit "$trailers
Verify:" >/dev/null
expect 3 'record cannot cover another commit with the same defect'

# Only verification can be supplemented; Loop, Thread and binary checks still run.
g checkout -q --detach "$base"
no_loop=$(commit $'Thread: mcp:00000000-0000-0000-0000-000000000000\nVerify:')
record "$no_loop"; expect 3 'missing Loop'
g checkout -q --detach "$base"
no_thread=$(commit $'Loop: test\nVerify:')
record "$no_thread"; expect 3 'missing Thread'
g checkout -q --detach "$base"
bad_thread=$(commit $'Loop: test\nThread: invalid\nVerify:')
record "$bad_thread"; expect 3 'invalid Thread'
g checkout -q --detach "$base"
python3 -c 'open("large.bin", "wb").write(b"\0" * 1048577)'
g add large.bin
binary=$(commit "$trailers
Verify:")
record "$binary"; expect 6 'supplement cannot bypass large binary gate'
echo 'ok - trusted SHA-bound verification; candidate/implicit/wrong/malformed records rejected; other gates enforced'
