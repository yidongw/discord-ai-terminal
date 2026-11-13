#!/usr/bin/env bash
# The review contract (CLAUDE.md "Shipping"; review.yml + scripts/ci/{hotfix-review-base,dev-review-base,review-passed}.sh)
# against a fake git history and a fake GitHub (gh + curl answer from JSON fixtures). No network.
#   (a) main ranges start at the last COMPLETED main review; merges / Train-Merge heads are not moved past
#   (b) a tests-only-fix round passes only with the trusted tests and only when every dev commit repairs a completed,
#       blocked review; a skipped blocking step is never a pass otherwise
#   (c) coverage follows a chain of completed reviews P → A → B; a skipped review is never a link
#   (d) review.yml uploads only this run's attestation;  (f) first run: the deployed sha, not ancient history
#   (e) provenance: only workflow_run runs of main count as evidence, in every reader; every page of runs is read
#   (g) a tests-only fix lands only as a main head review.yml re-checks; its approval holds after main advanced onto it
#   (h) a review without a usable attestation is no range base; an unprovable run does not hide an older provable one
set -uo pipefail
CI=$(cd "$(dirname "$0")" && pwd); ROOT=$(cd "$CI/../.." && pwd)
T=$(mktemp -d); trap 'rm -rf "$T"' EXIT
FAILS=0   # KEEP_GOING=1: report every failing check instead of stopping at the first
fail() { echo "FAIL: $*" >&2; [ -n "${KEEP_GOING:-}" ] || exit 1; FAILS=$((FAILS + 1)); }
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
        rs = [dict({"event": "workflow_run", "head_branch": "main"}, **r) for r in runs()]
        if "event" in q: rs = [r for r in rs if r["event"] == q["event"]]
        if "branch" in q: rs = [r for r in rs if r["head_branch"] == q["branch"]]
        if q.get("status") == "completed": rs = [r for r in rs if r.get("status", "completed") == "completed"]
        if q.get("status") == "success": rs = [r for r in rs if r.get("conclusion") == "success"]
        n = int(q.get("per_page", "30")); pg = int(q.get("page", "1"))
        return {"workflow_runs": [dict(r, path=".github/workflows/review.yml") for r in rs[(pg - 1) * n:pg * n]]}
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
  # env: RUN_EVENT / RUN_BRANCH (default: a trusted workflow_run run of main), ATT_MAIN (the attestation's "main")
  local id=$1 title=$2 tc=$3 st=$4 base=${5:-} kind=${6:-} blk=${7:-} rc=success steps="[]"
  [ "$st" = - ] || steps="[{\"name\":\"Review (blocking; tralyx main's reviewer, this repo's diff)\",\"conclusion\":\"$st\"}]"
  [ "$st" = failure ] && rc=failure
  echo "{\"jobs\":[{\"name\":\"tests\",\"conclusion\":\"$tc\"},{\"name\":\"review\",\"id\":$((id + 1000)),\"conclusion\":\"$rc\",\"steps\":$steps}]}" > "$FX/jobs-$id.json"
  [ -n "$blk" ] && printf 'review-range: %s %s\nreview-gate: BLOCKED #1 regression [blocker]: x\n' "${base:-0000000000000000000000000000000000000000}" "${title#* }" > "$FX/log-$((id + 1000)).txt"
  [ -n "$base" ] && echo "{\"head\":\"${title#* }\",\"base\":\"$base\"${kind:+,\"kind\":\"$kind\"}${ATT_MAIN:+,\"main\":\"$ATT_MAIN\"}}" > "$FX/attest-$id.json"
  local concl=success; [ "$tc" = success ] && [ "$rc" = success ] || concl=failure
  RUNS=("{\"id\":$id,\"display_title\":\"$title\",\"status\":\"completed\",\"conclusion\":\"$concl\"${RUN_EVENT:+,\"event\":\"$RUN_EVENT\"}${RUN_BRANCH:+,\"head_branch\":\"$RUN_BRANCH\"}}" "${RUNS[@]}")
  write_runs
}
write_runs() { printf '{"workflow_runs":[%s]}\n' "$(IFS=,; echo "${RUNS[*]}")" > "$FX/runs.json"; }
pad_runs() { # pad_runs <n> → n newer dev runs of unrelated shas (a full API page that names no commit of the fixture)
  local i
  for i in $(seq 1 "$1"); do RUNS=("{\"id\":$((90000 + i)),\"display_title\":\"review $(printf '%040x' "$i")\",\"status\":\"completed\",\"conclusion\":\"success\"}" "${RUNS[@]}"); done
  write_runs
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
# (h) #7: a newer incremental run of B whose predecessor proof is missing does not hide the older full-range run of B
reset; run 2 "review $B" success success "$P"; run 8 "review $B" success success "$A"
RP "$B" o/r "$P" || fail "(h) an unprovable newer run of B stopped the older full-range run of B from being used: $(cat "$T/err")"
echo "ok (c)(h) - coverage chain P → A → B; a skipped or missing review is never a link; every successful run is tried"

# (h) #4: range producers start only at a review whose attestation the approval consumer can read
git update-ref refs/remotes/origin/main "$P"
DB() { bash "$CI/dev-review-base.sh" "$@" 2>/dev/null; }
reset; run 1 "review $A" success success "$P"
[ "$(DB "$B")" = "$A" ] || fail "(h) dev range of B does not start at A's completed, attested review (got $(DB "$B"))"
rm -f "$FX/attest-1.json"
[ "$(DB "$B")" = "$P" ] || fail "(h) dev range of B starts at A although A's attestation is unavailable (got $(DB "$B")) — review-passed.sh cannot prove that range"
# (e) #1: a run a branch made itself (push event, its own branch) is no evidence for the dev range either
reset; RUN_EVENT=push RUN_BRANCH=attacker run 1 "review $A" success success "$P"
[ "$(DB "$B")" = "$P" ] || fail "(e) dev range of B starts at a 'review A' run that a branch generated (got $(DB "$B"))"
echo "ok (h)(e) - dev range: only trusted, attested reviews are a base"

# (b) tests-only fix rounds
git update-ref refs/remotes/origin/main "$P"
S=$(c "dev change"); F=$(c "fix" "Review-Fix-Of: $S")
reset; run 3 "review $S" success failure "$P" "" blocked; ATT_MAIN=$P run 4 "review $F" success skipped "$S" tests-only-fix
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
# (e) #1: the alleged blocked review of S is a branch's own run (push event, branch attacker): no repair eligibility
reset; RUN_EVENT=push RUN_BRANCH=attacker run 3 "review $S" success failure "$P" "" blocked; run 4 "review $F" success skipped "$S" tests-only-fix
bash "$CI/dev-review-base.sh" --only-fixes "$S" "$F" 2>/dev/null && fail "(e) --only-fixes accepted a branch-generated 'review S' run as the blocked review"
RP "$F" o/r && fail "(e) a tests-only fix was approved on a branch-generated blocked review"
# (g) #3: the approval of F holds after origin/main advanced onto F (the boundary is the attested one, not the live ref)
reset; run 3 "review $S" success failure "$P" "" blocked; ATT_MAIN=$P run 4 "review $F" success skipped "$S" tests-only-fix
RP "$F" o/r "$P" || fail "(g) tests-only fix F is refused for deployed P: $(cat "$T/err")"
git update-ref refs/remotes/origin/main "$F"
RP "$F" o/r "$P" || fail "(g) the same approval of F turned invalid once origin/main advanced to F: $(cat "$T/err")"
git update-ref refs/remotes/origin/main "$P"
echo "ok (b)(e)(g) - tests-only fix: green tests + every commit repairs a completed blocked review of a trusted run; stable after landing"

# (g) #2: merge-branch.sh lands a tests-only approval only as a head that main's review.yml re-checks
MB=$T/mb; mkdir -p "$MB"; cp "$CI/merge-branch.sh" "$MB/"
printf '%s\n' '#!/usr/bin/env bash' '[ -z "${REVIEW_KIND_OUT:-}" ] || echo "$STUB_KIND" > "$REVIEW_KIND_OUT"' 'echo "stub approval of $1"' > "$MB/review-passed.sh"
git init -q --bare "$T/remote.git"; g remote add origin "$T/remote.git"
land() { # land <kind> <sha> → merge-branch.sh with that approval kind, main at P before
  git push -q -f origin "$P:refs/heads/main" "$2:refs/heads/dev" 2>/dev/null; STUB_KIND=$1 bash "$MB/merge-branch.sh" dev "$2" >/dev/null 2>"$T/err"
}
land tests-only-fix "$X" && fail "(g) a tests-only approval landed a head without Review-Fix-Of: / Hotfix: / Train-Merge: — main would not review it"
[ "$(git ls-remote origin refs/heads/main | cut -f1)" = "$P" ] || fail "(g) main moved on a refused tests-only landing"
land tests-only-fix "$F" || fail "(g) a tests-only fix carrying Review-Fix-Of: is refused: $(cat "$T/err")"
[ "$(git ls-remote origin refs/heads/main | cut -f1)" = "$F" ] || fail "(g) the tests-only fix did not land"
land review "$X" || fail "(g) a reviewed head is refused: $(cat "$T/err")"
g remote remove origin; git update-ref refs/remotes/origin/main "$P"
# … and review.yml starts tests + review + status for a Review-Fix-Of: main head, and its range step accepts it
W=$ROOT/.github/workflows/review.yml
[ "$(grep -c "contains(github.event.workflow_run.head_commit.message, 'Review-Fix-Of: ')" "$W")" = 3 ] || fail "(g) review.yml: tests / review / status do not all run for a Review-Fix-Of: main head"
grep -qF "Train-Merge: [0-9a-f]{40}|Review-Fix-Of: [0-9a-f]{40})'" "$W" || fail "(g) review.yml: the range step refuses a Review-Fix-Of: main head"
grep -qF '"main":"%s"' "$W" || fail "(g) review.yml: the attestation does not record the main boundary"
echo "ok (g) - a tests-only fix lands only where main re-checks it (merge-branch.sh + review.yml triggers)"

# (a) + (f) main ranges
g checkout -q --detach "$P"; H1=$(c "hotfix one" "Hotfix: one" h)
g checkout -q -b side "$S"; g checkout -q --detach "$H1"; g merge -q --no-ff -m "train merge" -m "Train-Merge: $S" side; TM=$(git rev-parse HEAD)
H2=$(c "hotfix two" "Hotfix: two
Review-Fix-Of: $TM
Review-Fix-Of: $H1" h)
base() { bash "$CI/hotfix-review-base.sh" "$@" 2>/dev/null; }
reset; run 6 "recheck $H1" success success "$P"
[ "$(base "$H2")" = "$H1" ] || fail "(a) main range after a merge does not start at the last completed main review H1 (got $(base "$H2"))"
reset; run 6 "recheck $H1" success success "$P"; run 7 "recheck $TM" success failure "$H1"   # gates died: no verdict
[ "$(base "$H2")" = "$H1" ] || fail "(a) a main review that died before its verdict counted as completed"
reset; run 6 "recheck $H1" success success "$P"; run 7 "recheck $TM" success failure "$H1" "" blocked
[ "$(base "$H2")" = "$TM" ] || fail "(a) a blocked main review of the Train-Merge head did not count as completed"
# (e) #1: a branch-generated "recheck" is no completed main review
reset; RUN_EVENT=push RUN_BRANCH=attacker run 6 "recheck $H1" success success "$P"
[ "$(base "$H2")" = "$TM" ] || fail "(e) a branch-generated 'recheck H1' run counted as a completed main review (got $(base "$H2"))"
# (h) #4: a completed main review without its attestation is no base
reset; run 6 "recheck $H1" success success
[ "$(base "$H2")" = "$TM" ] || fail "(h) main range starts at H1 although its attestation is unavailable (got $(base "$H2"))"
# #5: the verdict is found whatever follows it in the log (no SIGPIPE from an early-closing grep)
reset; run 6 "recheck $H1" success failure "$P" "" blocked
python3 -c 'import sys; sys.stdout.write(("x" * 99 + "\n") * 25000)' >> "$FX/log-1006.txt"
[ "$(base "$H2")" = "$H1" ] || fail "#5 a blocked verdict followed by 2.5 MB of log was not seen as a completed main review (got $(base "$H2"))"
# #6: a full page of dev runs is not the end of the list
reset; run 6 "recheck $H1" success success "$P"; pad_runs 100
[ "$(base "$H2")" = "$H1" ] || fail "#6 the completed main review behind a full page of dev runs was missed (got $(base "$H2"))"
# (g) a tests-only round ends at a fix commit (its trailer starts the main re-check): a range ending in a merge is reviewed
g checkout -q --detach "$F"; g merge -q --no-ff -m "merge main into dev" "$H1"; MG=$(git rev-parse HEAD); g checkout -q --detach "$H2"
reset; run 3 "review $S" success failure "$P" "" blocked
DEV_REVIEW_MAIN_REF=$H1 bash "$CI/dev-review-base.sh" --only-fixes "$S" "$F" 2>/dev/null || fail "(g) fixture: S..F is not a tests-only range"
DEV_REVIEW_MAIN_REF=$H1 bash "$CI/dev-review-base.sh" --only-fixes "$S" "$MG" 2>/dev/null && fail "(g) a tests-only range ending in a merge (no trailer to start the main re-check) was accepted"
reset; git tag -f deployed "$H1" >/dev/null
[ "$(base "$H2")" = "$H1" ] || fail "(f) no completed main review: range does not start at the deployed sha"
git tag -d deployed >/dev/null
[ "$(base "$H2")" = "$TM" ] || fail "(f) no completed review and no deployed tag: not the parent"
echo "ok (a)(e)(f)(h) - main: since the last completed, trusted, attested review (merges not skipped; every page; whole log); first run: the deployed sha"

bash "$CI/test-review-regressions.sh" || fail "supplemental coverage/boundary regressions"
bash "$CI/test-review-trailers.sh" || fail "long-message trailer readers"
bash "$CI/test-commit-gates.sh" || fail "commit verification regressions"
python3 "$CI/test-runner-workspaces.py" || fail "runner workspace isolation regressions"

# (a)(b)(d) review.yml wiring (needs PyYAML; the InstaBox test VM has none — checked where it exists)
done_() { [ "$FAILS" = 0 ] || { echo "$FAILS check(s) failed" >&2; exit 1; }; echo "all passed"; exit 0; }
if ! python3 -c 'import yaml' 2>/dev/null; then echo "skip (a)(b)(d) review.yml wiring: no PyYAML here"; done_; fi
python3 - "$ROOT/.github/workflows/review.yml" <<'PY' || fail "review.yml wiring"
import sys, yaml
j = yaml.safe_load(open(sys.argv[1]))["jobs"]; r = j["review"]; steps = r["steps"]
names = [s.get("name", s.get("uses", "")) for s in steps]
blocking = next(s for s in steps if s.get("name", "").startswith("Review (blocking"))
upload = next(s for s in steps if "upload-artifact" in s.get("uses", ""))
attest = next(s for s in steps if s.get("name", "").startswith("Attestation"))
checks = {
  "Train-Merge heads are reviewed": "Train-Merge: " in r["if"],
  "Review-Fix-Of heads are reviewed on main": "Review-Fix-Of: " in r["if"] and "Review-Fix-Of: " in j["tests"]["if"] and "Review-Fix-Of: " in j["status"]["if"],
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
done_
