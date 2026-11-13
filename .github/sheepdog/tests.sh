#!/usr/bin/env bash
# The trusted test list of discord-ai-terminal (sheepdog's `tests` job runs this file from main, in a checkout of the
# pushed commit: the current directory). The checks: bun install (frozen lockfile), tsc over src/ (tsconfig.ci.json),
# a bun build of src/index.ts (every import resolves), the MCP smoke test (scripts/ci/smoke-mcp.ts: /health,
# /tool/wake_thread, /mcp initialize on a local port), `bun test` measured against test/known-failures.txt (a failing
# test that is not listed there fails the job; the list may only shrink), and the InstaBox runner workspace isolation
# regressions (scripts/ci/test-runner-workspaces.py).
#
# Unreviewed code runs only on the InstaBox VM, and there never as the runner's own identity: every candidate command
# runs as a THROWAWAY user created for this job (datci<run id>: not in the docker or sudo group, its own home/TMPDIR,
# no write access to any runner directory; the runner dirs are 0750), killed and deleted at the end (the EXIT trap
# below + the runner's root-owned job-completed hook as a backstop). The runner's job-started hook admits only this
# job and holds the VM-wide one-job-at-a-time lock (/srv/ci-serial.sh: two suites at once OOM the 8 GB VM).
set -euo pipefail
WS=$PWD

# ── throwaway test user (trusted, as the runner) ──
CIU=datci${GITHUB_RUN_ID:?}
CID=/data/discord-ai-terminal-work/ci/$CIU
cleanup() {
  sudo pkill -KILL -u "$CIU" || true
  sleep 1
  sudo userdel "$CIU" || true
  sudo rm -rf "$CID"
}
trap cleanup EXIT
sudo useradd --system --user-group --no-create-home --home-dir "$CID" --shell /usr/sbin/nologin "$CIU"
sudo install -d -o root -g root -m 755 /data/discord-ai-terminal-work/ci "$CID"
sudo install -d -o "$CIU" -g "$CIU" -m 700 "$CID/home" "$CID/tmp" "$CID/src"
sudo install -d -o root -g root -m 755 "$CID/bin"
sudo install -o root -g root -m 755 "$(command -v bun)" "$CID/bin/bun"
sudo ln -s bun "$CID/bin/bunx"
sudo cp -a "$WS/." "$CID/src/" && sudo chown -R "$CIU:$CIU" "$CID/src"
export CIU CID
# how every candidate command below runs: as $CIU, clean environment, in its copy of the tree
as_ci() {
  sudo -n -u "$CIU" env -i HOME="$CID/home" TMPDIR="$CID/tmp" PATH="$CID/bin:/usr/local/bin:/usr/bin:/bin" LANG=C.UTF-8 CI=true \
    BUN_INSTALL_CACHE_DIR="$CID/home/.bun-cache" bash -c "cd \"$CID/src\" && $1"
}

echo "::group::The test user has no Docker, no sudo, no runner access (fail closed)"
as_ci '
  id
  if id -nG | tr " " "\n" | grep -xE "docker|sudo|user" >/dev/null; then echo "::error::test user in a privileged group"; exit 1; fi
  for s in /var/run/docker.sock /run/docker.sock; do
    [ -e "$s" ] || continue
    if [ -r "$s" ] || [ -w "$s" ] || curl -s -m 5 --unix-socket "$s" http://localhost/_ping >/dev/null 2>&1; then echo "::error::$s usable"; exit 1; fi
  done
  if sudo -n true 2>/dev/null; then echo "::error::test user has sudo"; exit 1; fi
  for d in /srv/discord-ai-terminal-r1 /srv/foxhole-backend-r1 /srv/tralyx-r1 /data/discord-ai-terminal-work /data/home; do
    if [ -w "$d" ] || ls "$d/.credentials" >/dev/null 2>&1; then echo "::error::test user can write $d or read a runner credential"; exit 1; fi
  done
  echo "ok: $(id -un) has no Docker, no sudo, no runner access"'
echo "::endgroup::"

echo "::group::Install"; as_ci "bun install --frozen-lockfile"; echo "::endgroup::"
echo "::group::Typecheck (src)"; as_ci "bunx tsc --noEmit -p tsconfig.ci.json"; echo "::endgroup::"
echo "::group::Build (every import of src/index.ts resolves)"; as_ci "bun build src/index.ts --target=bun --outdir \"\$TMPDIR/build\" >/dev/null"; echo "::endgroup::"
echo "::group::MCP smoke test (/health, /tool/wake_thread, /mcp)"; as_ci "timeout 60 bun run scripts/ci/smoke-mcp.ts"; echo "::endgroup::"

echo "::group::Unit tests (bun test; nothing may fail that test/known-failures.txt does not list)"
as_ci "timeout 600 bun test" > "$RUNNER_TEMP/bun-test.out" 2>&1 || true
sed -E 's/\x1b\[[0-9;]*m//g' "$RUNNER_TEMP/bun-test.out" > "$RUNNER_TEMP/bun-test.txt"
tail -8 "$RUNNER_TEMP/bun-test.txt"
grep -qE '^Ran [1-9][0-9]* tests? across' "$RUNNER_TEMP/bun-test.txt" || { echo "::error::bun test did not finish (no summary line)"; tail -40 "$RUNNER_TEMP/bun-test.txt"; exit 1; }
grep -E '^\(fail\) ' "$RUNNER_TEMP/bun-test.txt" | sed -E 's/ \[[0-9.]+(ms|s)\]$//' | sort -u > "$RUNNER_TEMP/failed.txt" || true
# the runner's own checkout: the test user cannot rewrite it while the suite runs
grep -E '^\(fail\) ' "$WS/test/known-failures.txt" 2>/dev/null | sort -u > "$RUNNER_TEMP/known.txt" || true
new=$(comm -23 "$RUNNER_TEMP/failed.txt" "$RUNNER_TEMP/known.txt")
echo "failed: $(wc -l < "$RUNNER_TEMP/failed.txt"), listed as known: $(wc -l < "$RUNNER_TEMP/known.txt")"
if [ -n "$new" ]; then
  echo "::error::tests failing that test/known-failures.txt does not list:"
  printf '%s\n' "$new" | sed 's/^/ × /'
  # the reason: bun prints a failing test's error output just before its "(fail)" line — show it per test
  printf '%s\n' "$new" | while IFS= read -r l; do
    n=$(grep -nF -m 1 -- "$l" "$RUNNER_TEMP/bun-test.txt" | cut -d: -f1); [ -n "$n" ] || continue
    echo "::group::output before $l"; sed -n "$(( n > 40 ? n - 40 : 1 )),${n}p" "$RUNNER_TEMP/bun-test.txt"; echo "::endgroup::"
  done
  exit 1
fi
echo "ok: no new test failures"
echo "::endgroup::"

echo "::group::Runner workspace isolation (scripts/ci/test-runner-workspaces.py, no network)"
as_ci "python3 scripts/ci/test-runner-workspaces.py"
echo "::endgroup::"
