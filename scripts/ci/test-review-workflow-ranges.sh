#!/usr/bin/env bash
# Execute the workflow's range and gate steps on offline histories, including clean merges.
set -euo pipefail
. "$(dirname "${BASH_SOURCE[0]}")/test-review-fixtures.sh"
mkdir -p "$T/.trusted/scripts"
ln -s "$CI" "$T/.trusted/scripts/ci"
mv "$T/src" "$T/candidate"; cd "$T/candidate"
export GITHUB_ENV=$T/env GITHUB_OUTPUT=$T/output

# Extract actual workflow commands so changes to their wiring are exercised too.
python3 - "$ROOT/.github/workflows/review.yml" "$T" <<'PY'
import pathlib, sys, textwrap
lines = pathlib.Path(sys.argv[1]).read_text().splitlines(keepends=True)
for name, target in [('Reviewed range', 'range'), ("Commit gates (main's script, the branch's commits)", 'gates')]:
    start = lines.index(f'      - name: {name}\n') + 1
    while not lines[start].startswith('        run:'):
        assert not lines[start].startswith('      - '), f'{name}: run not found'
        start += 1
    if lines[start] == '        run: |\n':
        end = start + 1
        while end < len(lines) and (lines[end].startswith('          ') or not lines[end].strip()):
            end += 1
        script = textwrap.dedent(''.join(lines[start + 1:end]))
    else:
        script = lines[start].split('run: ', 1)[1]
    for branch in ['main', 'dev']:
        content = script.replace('${{ github.event.workflow_run.head_branch }}', branch)
        assert '${{' not in content, 'unhandled workflow expression'
        pathlib.Path(sys.argv[2], f'{target}-{branch}.sh').write_text(content)
PY
range_step() {
  local status=0
  : > "$GITHUB_ENV"; : > "$GITHUB_OUTPUT"
  bash -e -o pipefail "$T/range-$1.sh" > "$T/range.log" 2>&1 || status=$?
  [ "$status" = 0 ] || fail "range step failed ($1, exit $status)"
  # Export exactly the environment a later Actions step receives.
  set -a; . "$GITHUB_ENV"; set +a
}
gates() { bash -e -o pipefail "$T/gates-dev.sh" > "$T/gates.log" 2>&1; }
valid=$'Loop: fixture\nThread: mcp:42a17050-1bff-4215-a341-2f640bab5c10\nVerify:\n- [x] offline fixture'

case "${1:-}" in
  --gates)
    P=$(c prod); git update-ref refs/remotes/origin/main "$P"
    A=$(c dev "$valid" devfile)
    g checkout -q --detach "$P"; H=$(c main "$valid" mainfile)
    git update-ref refs/remotes/origin/main "$H"
    reset; run 1 "review $A" success success "$P"; run 2 "recheck $H" success success "$P"
    for merge_valid in no yes; do
      g checkout -q --detach "$A"
      msg=merge; [ "$merge_valid" = no ] || msg+=$'\n\n'"$valid"
      g merge -q --no-ff -m "$msg" "$H"; M=$(git rev-parse HEAD)
      B=$(c next "$valid" devfile)
      range_step dev
      [ "$REVIEW_BASE" = "$M" ] || fail 'clean merge no longer shortens the code diff'
      status=0; gates || status=$?
      if [ "$merge_valid" = no ]; then
        [ "$status" = 3 ] || fail "unchecked clean merge passed workflow gates (exit $status)"
        grep -q "commit ${M:0:7}.*missing trailer(s): Loop: Verify: Thread:" "$T/gates.log" || fail 'merge trailer errors absent'
      else
        [ "$status" = 0 ] || fail "valid clean merge rejected: $(cat "$T/gates.log")"
      fi
      [ "$GATE_BASE" = "$A" ] || fail 'gates lost the original coverage boundary'
    done
    # The same boundary is mandatory when the reviewer is skipped for a fix round.
    S=$(c blocked "$valid" devfile)
    run 3 "review $S" success failure "$M" '' blocked
    # Create another independently reviewed main commit to merge into the blocked dev head.
    g checkout -q --detach "$H"; H2=$(c main2 "$valid" mainfile)
    run 4 "recheck $H2" success success "$H"
    git update-ref refs/remotes/origin/main "$H2"
    g checkout -q --detach "$S"; g merge -q --no-ff -m merge "$H2"
    B=$(c repair "$valid"$'\n'"Review-Fix-Of: $S" devfile)
    range_step dev
    grep -qx 'kind=tests-only-fix' "$GITHUB_OUTPUT" || fail 'fixture was not a tests-only fix round'
    status=0; gates || status=$?
    [ "$status" = 3 ] || fail 'tests-only round bypassed merge gates'
    echo 'ok: normal and tests-only dev rounds gate new merges; valid merge passes'
    ;;
  --summary)
    P=$(c prod); git update-ref refs/remotes/origin/main "$P"; git tag deployed "$P"
    # Long subjects force the original git log | head pipeline to hit a closed pipe.
    python3 - <<'PY'
import subprocess
for i in range(70):
    subprocess.run(['git', '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q',
                    '--allow-empty', '-m', f'commit-{i:02d}-' + 'x' * 4096,
                    '-m', 'Hotfix: summary fixture'], check=True)
PY
    for branch in main dev; do
      range_step "$branch"
      [ "$REVIEW_BASE" = "$P" ] && [ "$GATE_BASE" = "$P" ] || fail 'range environment missing'
      [ "$(grep -c 'commit-[0-9][0-9]-' "$T/range.log")" = 50 ] || fail 'summary did not contain exactly 50 commits'
      grep -qx 'kind=review' "$GITHUB_OUTPUT" || fail 'range output missing'
    done
    echo 'ok: long main/dev ranges finish and publish their environment with 50 summary entries'
    ;;
  *) fail 'usage: test-review-workflow-ranges.sh --gates|--summary' ;;
esac
