#!/usr/bin/env bash
# The review contract (CLAUDE.md "Shipping"; review.yml + scripts/ci/{hotfix-review-base,dev-review-base,review-passed}.sh)
# against a fake git history and a fake GitHub (gh + curl answer from JSON fixtures). No network.
#   (a) main ranges start at the last COMPLETED main review; merges / Train-Merge heads are not moved past
#   (b) a tests-only-fix round passes only with the trusted tests and only when every dev commit repairs a completed,
#       blocked review; a skipped blocking step is never a pass otherwise
#   (c) coverage follows a chain of completed reviews P → A → B; a skipped review is never a link
#   (d) review.yml uploads only this run's attestation;  (f) first run: the deployed sha, not ancient history
set -uo pipefail
CI=$(cd "$(dirname "$0")" && pwd); ROOT=$(cd "$CI/../.." && pwd)
T=$(mktemp -d); trap 'rm -rf "$T"' EXIT
fail() { echo "FAIL: $*" >&2; exit 1; }
FX=$T/fx; mkdir -p "$FX" "$T/bin"; export FX
cat > "$T/bin/fakegh.py" <<'PY'
import json, os, re, sys, io, zipfile
FX = os.environ["FX"]
def runs():
    try: return json.load(open(f"{FX}/runs.json"))["workflow_runs"]
    except FileNotFoundError: return []
def answer(path):
    path = re.sub(r"^https://api\.github\.com/", "", path); path = re.sub(r"^repos/[^/]+/[^/]+/", "", path)
    m = re.match(r"actions/workflows/review\.yml/runs\??(.*)", path)
    if m:
        q = dict(kv.split("=", 1) for kv in m.group(1).split("&") if "=" in kv)
        if q.get("page", "1") != "1": return {"workflow_runs": []}
        rs = runs()
        if q.get("status") == "completed": rs = [r for r in rs if r.get("status", "completed") == "completed"]
        if q.get("status") == "success": rs = [r for r in rs if r.get("conclusion") == "success"]
        return {"workflow_runs": [dict(r, path=".github/workflows/review.yml") for r in rs]}
    m = re.match(r"actions/runs/(\d+)/jobs$", path)
    if m: return json.load(open(f"{FX}/jobs-{m.group(1)}.json"))
    m = re.match(r"actions/runs/(\d+)/artifacts$", path)
    if m: return {"artifacts": [{"name": "review-attestation", "id": int(m.group(1))}] if os.path.exists(f"{FX}/attest-{m.group(1)}.json") else []}
    m = re.match(r"actions/artifacts/(\d+)/zip$", path)
    if m:
        b = io.BytesIO(); z = zipfile.ZipFile(b, "w"); z.write(f"{FX}/attest-{m.group(1)}.json", "review-attestation.json"); z.close()
        sys.stdout.buffer.write(b.getvalue()); sys.exit(0)
    m = re.match(r"actions/jobs/(\d+)/logs$", path)
    if m:
        f = f"{FX}/log-{m.group(1)}.txt"
        if not os.path.exists(f): sys.exit(22)
        for l in open(f): sys.stdout.write("2026-11-13T00:00:00.0000000Z " + l)
        sys.exit(0)
    sys.exit(22)
r = answer(sys.argv[1]); sys.stdout.write(json.dumps(r))
PY
cat > "$T/bin/gh" <<'SH'
#!/usr/bin/env bash
[ "$1" = api ] || exit 1; shift; p=""; q=""
while [ $# -gt 0 ]; do case "$1" in -q) q=$2; shift 2 ;; --paginate) shift ;; -*) shift ;; *) [ -z "$p" ] && p=$1; shift ;; esac; done
case "$p" in */zip|*/logs) python3 "$(dirname "$0")/fakegh.py" "$p"; exit ;; esac
out=$(python3 "$(dirname "$0")/fakegh.py" "$p") || exit 1
if [ -n "$q" ]; then jq -r "$q" <<<"$out"; else printf '%s\n' "$out"; fi
SH
cat > "$T/bin/curl" <<'SH'
#!/usr/bin/env bash
url=""; for a in "$@"; do case "$a" in http*) url=$a ;; esac; done
python3 "$(dirname "$0")/fakegh.py" "$url"
SH
chmod +x "$T/bin/gh" "$T/bin/curl"; export PATH=$T/bin:$PATH GH_TOKEN=x REPO=o/r

# fake GitHub fixtures
RUNS=()
run() { # run <id> <title> <tests concl> <blocking step concl|-> [<attest base> <kind>] [blocked]
  local id=$1 title=$2 tc=$3 st=$4 base=${5:-} kind=${6:-} blk=${7:-} rc=success steps="[]"
  [ "$st" = - ] || steps="[{\"name\":\"Review (blocking; tralyx main's reviewer, this repo's diff)\",\"conclusion\":\"$st\"}]"
  [ "$st" = failure ] && rc=failure
  echo "{\"jobs\":[{\"name\":\"tests\",\"conclusion\":\"$tc\"},{\"name\":\"review\",\"id\":$((id + 1000)),\"conclusion\":\"$rc\",\"steps\":$steps}]}" > "$FX/jobs-$id.json"
  [ -n "$blk" ] && printf 'review-range: %s %s\nreview-gate: BLOCKED #1 regression [blocker]: x\n' "${base:-0000000000000000000000000000000000000000}" "${title#* }" > "$FX/log-$((id + 1000)).txt"
  [ -n "$base" ] && echo "{\"head\":\"${title#* }\",\"base\":\"$base\"${kind:+,\"kind\":\"$kind\"}}" > "$FX/attest-$id.json"
  local concl=success; [ "$tc" = success ] && [ "$rc" = success ] || concl=failure
  RUNS=("{\"id\":$id,\"display_title\":\"$title\",\"status\":\"completed\",\"conclusion\":\"$concl\"}" "${RUNS[@]}")
  printf '{"workflow_runs":[%s]}\n' "$(IFS=,; echo "${RUNS[*]}")" > "$FX/runs.json"
}
reset() { RUNS=(); rm -f "$FX"/*; }

git init -q -b main "$T/src"; cd "$T/src"
g() { git -c user.name=t -c user.email=t@t "$@"; }
c() { echo "$RANDOM$RANDOM" >> "${3:-f}"; g add -A; g commit -q -m "$1" ${2:+-m "$2"}; git rev-parse HEAD; }
RP() { bash "$CI/review-passed.sh" "$@" >/dev/null 2>"$T/err"; }

# (c) chain P → A → B
P=$(c prod); A=$(c a); B=$(c b)
reset; run 1 "review $A" success success "$P"; run 2 "review $B" success success "$A"
RP "$B" o/r "$P" || fail "(c) B (base A) with A's completed review (base P) does not cover deployed P: $(cat "$T/err")"
reset; run 1 "review $A" success skipped "$P" tests-only-fix; run 2 "review $B" success success "$A"
RP "$B" o/r "$P" && fail "(c) a skipped review of A was used as a link of the coverage chain"
reset; run 2 "review $B" success success "$A"
RP "$B" o/r "$P" && fail "(c) B is approved for deployed P with A never reviewed"
echo "ok (c) - coverage chain P → A → B; a skipped or missing review is never a link"

# (b) tests-only fix rounds
git update-ref refs/remotes/origin/main "$P"
S=$(c "dev change"); F=$(c "fix" "Review-Fix-Of: $S")
reset; run 3 "review $S" success failure "$P" "" blocked; run 4 "review $F" success skipped "$S" tests-only-fix
RP "$F" o/r || fail "(b) a tests-only fix of blocked S with green tests is refused: $(cat "$T/err")"
reset; run 3 "review $S" success failure "$P" "" blocked; run 4 "review $F" failure skipped "$S" tests-only-fix
RP "$F" o/r && fail "(b) a tests-only fix with red tests passed"
reset; run 3 "review $S" success failure "$P" "" blocked; run 4 "review $F" success skipped "$S" review
RP "$F" o/r && fail "(b) a skipped blocking step passed without the tests-only-fix attestation"
X=$(c "unrelated new code"); F2=$(c "fix again" "Review-Fix-Of: $S")
reset; run 3 "review $S" success failure "$P" "" blocked; run 5 "review $F2" success skipped "$S" tests-only-fix
RP "$F2" o/r && fail "(b) a 'tests-only-fix' range with an unreviewed non-fix commit passed"
reset; run 3 "review $S" failure - "$P"; run 4 "review $F" success skipped "$S" tests-only-fix
RP "$F" o/r && fail "(b) a fix of a commit whose review never completed passed as tests-only"
echo "ok (b) - tests-only fix: green tests + every commit repairs a completed blocked review; nothing else"

# (a) + (f) main ranges
g checkout -q --detach "$P"; H1=$(c "hotfix one" "Hotfix: one" h)
g checkout -q -b side "$S"; g checkout -q --detach "$H1"; g merge -q --no-ff -m "train merge" -m "Train-Merge: $S" side; TM=$(git rev-parse HEAD)
H2=$(c "hotfix two" "Hotfix: two" h)
base() { bash "$CI/hotfix-review-base.sh" "$@" 2>/dev/null; }
reset; run 6 "recheck $H1" success success "$P"
[ "$(base "$H2")" = "$H1" ] || fail "(a) main range after a merge does not start at the last completed main review H1 (got $(base "$H2"))"
reset; run 6 "recheck $H1" success success "$P"; run 7 "recheck $TM" success failure "$H1"   # gates died: no verdict
[ "$(base "$H2")" = "$H1" ] || fail "(a) a main review that died before its verdict counted as completed"
reset; run 6 "recheck $H1" success success "$P"; run 7 "recheck $TM" success failure "$H1" "" blocked
[ "$(base "$H2")" = "$TM" ] || fail "(a) a blocked main review of the Train-Merge head did not count as completed"
reset; git tag -f deployed "$H1" >/dev/null
[ "$(base "$H2")" = "$H1" ] || fail "(f) no completed main review: range does not start at the deployed sha"
git tag -d deployed >/dev/null
[ "$(base "$H2")" = "$TM" ] || fail "(f) no completed review and no deployed tag: not the parent"
echo "ok (a)(f) - main: since the last completed review (merges not skipped); first run: the deployed sha"

# (a)(b)(d) review.yml wiring (needs PyYAML; the InstaBox test VM has none — checked where it exists)
if ! python3 -c 'import yaml' 2>/dev/null; then echo "skip (a)(b)(d) review.yml wiring: no PyYAML here"; echo "all passed"; exit 0; fi
python3 - "$ROOT/.github/workflows/review.yml" <<'PY' || fail "review.yml wiring"
import sys, yaml
j = yaml.safe_load(open(sys.argv[1]))["jobs"]; r = j["review"]; steps = r["steps"]
names = [s.get("name", s.get("uses", "")) for s in steps]
blocking = next(s for s in steps if s.get("name", "").startswith("Review (blocking"))
upload = next(s for s in steps if "upload-artifact" in s.get("uses", ""))
attest = next(s for s in steps if s.get("name", "").startswith("Attestation"))
checks = {
  "Train-Merge heads are reviewed": "Train-Merge: " in r["if"],
  "one main reviewer": "review-main-reviewer" in r["concurrency"]["group"] and r["concurrency"]["cancel-in-progress"] is False,
  "attest/ cleaned first": "rm -rf attest" in steps[0].get("run", ""),
  "blocking step skipped (not passed) on tests-only fix": blocking.get("if") == "steps.range.outputs.kind == 'review'",
  "upload only after this run's attestation": attest.get("id") == "attest" and "steps.attest.outcome == 'success'" in str(upload.get("if")),
  "kind in the attestation": "steps.range.outputs.kind" in attest["run"],
}
bad = [k for k, v in checks.items() if not v]
print("review.yml:", "ok" if not bad else "missing: " + ", ".join(bad)); sys.exit(1 if bad else 0)
PY
echo "ok (a)(b)(d) - review.yml wiring"
echo "all passed"
