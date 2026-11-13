#!/usr/bin/env bash
# Shared offline git/GitHub fixtures. Source from the review contract/regression suites.
CI=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd); ROOT=$(cd "$CI/../.." && pwd)
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
        rs = runs()
        if q.get("status") == "completed": rs = [r for r in rs if r.get("status", "completed") == "completed"]
        if q.get("status") == "success": rs = [r for r in rs if r.get("conclusion") == "success"]
        start = (int(q.get("page", "1")) - 1) * 100
        return {"workflow_runs": rs[start:start + 100]}
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
  [ -n "$base" ] && echo "{\"head\":\"${title#* }\",\"base\":\"$base\"${kind:+,\"kind\":\"$kind\"}${kind:+,\"main\":\"$(git rev-parse origin/main)\"}}" > "$FX/attest-$id.json"
  local concl=success; [ "$tc" = success ] && [ "$rc" = success ] || concl=failure
  [ ! -f "$FX/runs.json" ] || mapfile -t RUNS < <(jq -c '.workflow_runs[]' "$FX/runs.json")
  RUNS=("{\"id\":$id,\"display_title\":\"$title\",\"status\":\"completed\",\"conclusion\":\"$concl\",\"event\":\"workflow_run\",\"head_branch\":\"main\",\"path\":\".github/workflows/review.yml\"}" "${RUNS[@]}")
  printf '{"workflow_runs":[%s]}\n' "$(IFS=,; echo "${RUNS[*]}")" > "$FX/runs.json"
}
reset() { RUNS=(); rm -f "$FX"/*; }

git init -q -b main "$T/src"; cd "$T/src"
g() { git -c user.name=t -c user.email=t@t "$@"; }
c() { echo "$RANDOM$RANDOM" >> "${3:-f}"; g add -A; g commit -q -m "$1" ${2:+-m "$2"}; git rev-parse HEAD; }
RP() { bash "$CI/review-passed.sh" "$@" >/dev/null 2>"$T/err"; }

