#!/usr/bin/env bash
# Commit gates for the review job (review.yml runs main's copy over the candidate's commits).
# Same rules as yidongw/tralyx scripts/commit-gates.sh + check-trailers.sh, minus its tralyx-only
# gates (TS parse of the live monitor, narrative version):
#   · every commit carries Loop:, Thread: and a Verify: checklist ('Verify:' alone on its line,
#     then '- [x] <evidence>' items); Thread: must be someone who can be woken (a Discord thread id,
#     a T3 thread uuid, mcp:<uuid> or import:<provider>:<uuid>) — review findings go there
#   · no commit adds a binary file over 1 MB
# Usage: scripts/ci/commit-gates.sh <base> <head>   (HEAD must be <head>)
# Exit: 0 ok · 3 trailer problem · 6 big binary · 2 usage
set -euo pipefail
BASE="${1:?usage: commit-gates.sh <base> <head>}"
HEAD_SHA="$(git rev-parse "${2:?usage: commit-gates.sh <base> <head>}")"
log() { echo "[gates $(date +%H:%M:%S)] $*"; }
[ "$(git rev-parse HEAD)" = "$HEAD_SHA" ] || { log "ERROR: HEAD is not $HEAD_SHA"; exit 2; }

commits="$(git rev-list "$BASE".."$HEAD_SHA")"
bad=0
for sha in $commits; do
  msg="$(git show -s --format=%B "$sha")"; short="$(git rev-parse --short "$sha")"
  miss=""
  grep -qiE '^Loop:[[:space:]]*[^[:space:]]' <<<"$msg" || miss="Loop:"
  # Verify: is a checklist: a bare 'Verify:' line followed (directly) by at least one '- [x] <evidence>' item
  awk 'BEGIN{v=0; ok=0} tolower($0) ~ /^verify:[[:space:]]*$/ {v=1; next} v && /^- \[[xX]\] *[^[:space:]]/ {ok=1} v && !/^- \[/ {v=0} END{exit ok?0:1}' <<<"$msg" || miss="$miss Verify:"
  grep -qiE '^Thread:[[:space:]]*[^[:space:]]' <<<"$msg" || miss="$miss Thread:"
  [ -z "$miss" ] || { log "ERROR: commit $short missing trailer(s): $miss (Verify: is a bare line followed by '- [x] …' items)"; bad=1; }
  t="$(grep -iE '^Thread:' <<<"$msg" | tail -1 | sed -E 's/^[Tt]hread:[[:space:]]*//' | tr -d '[:space:]' || true)"
  if [ -n "$t" ] && ! grep -qE '^([0-9]{17,20}|(mcp:|import:[A-Za-z]+:)?[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$' <<<"$t"; then
    log "ERROR: commit $short Thread:'$t' is neither a Discord nor a T3 thread id — review findings could not reach its author"; bad=1
  fi
done
[ "$bad" = 0 ] || { log "add to each commit message:  Loop: <loop | user | adhoc/topic>  +  Thread: <T3 uuid | Discord thread id>  +  a Verify: checklist"; exit 3; }

# Binary = what Git itself says (numstat '-	-': .gitattributes binary/-diff or a NUL byte), as in
# tralyx's gate; diffed against EVERY parent so a merge cannot bring one in unseen. Records are split
# by hand (not `read` with IFS=tab, which trims a trailing tab off the path), and a size that cannot
# be read fails the gate instead of passing as 0.
EMPTY_TREE=$(git hash-object -t tree /dev/null)
big=""
for sha in $commits; do
  parents=$(git rev-list --parents -n1 "$sha" | cut -d' ' -f2-); [ "$parents" != "$sha" ] || parents=$EMPTY_TREE
  for p in $parents; do
    while IFS= read -r -d '' rec; do
      added=${rec%%$'\t'*}; rest=${rec#*$'\t'}; deleted=${rest%%$'\t'*}; f=${rest#*$'\t'}
      [ "$added" = - ] && [ "$deleted" = - ] || continue
      [ -n "$(git ls-tree -z "$sha" -- ":(literal)$f" | tr -d '\0')" ] || continue   # deleted in this commit
      sz=$(git cat-file -s "$sha:$f") || { log "ERROR: cannot read $f in $(git rev-parse --short "$sha")"; exit 6; }
      [ "$sz" -le 1048576 ] || big="$big$(git rev-parse --short "$sha") $f ($sz bytes)"$'\n'
    done < <(git diff --numstat -z --no-renames "$p" "$sha")
  done
done
[ -z "$big" ] || { log "ERROR: these commits add binary files over 1 MB:"; printf '%s' "$big" | sed 's/^/    /'; exit 6; }
log "ok: $(wc -w <<<"$commits" | tr -d ' ') commit(s) in ${BASE:0:12}..${HEAD_SHA:0:12}"
