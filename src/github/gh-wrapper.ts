import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import * as crypto from "crypto";

// HMAC token that the gh wrapper sends to authenticate control server requests.
// Derived from the shared secret + threadId so the server can verify without
// a per-thread secret store.
export function computeLinkerToken(secret: string, threadId: string): string {
  return crypto.createHmac("sha256", secret).update(threadId).digest("hex");
}

// Create a temporary bin directory for the thread and write a `gh` wrapper
// script inside it. The wrapper intercepts every `gh` invocation:
//   1. Pre-flight  – POSTs to /preflight so the control server can log and
//      optionally block the command. Fails open if the server is unreachable.
//   2. Execution   – runs the real gh with all original args.
//   3. Post-flight – for `gh pr create`, extracts repo+prNumber from the PR
//      URL and POSTs them to /link-pr so the server links the PR to this
//      thread immediately, before any GitHub webhook fires.
//
// Covers both code paths that invoke gh: cc's in-session Bash tool calls AND
// the Stop hook's `gh pr create`. Both inherit the agent's PATH, so both
// resolve `gh` to this wrapper.
//
// Returns the bin directory path to be prepended to the agent's PATH.
export function createGhWrapper(
  threadId: string,
  controlPort: number,
  linkerSecret: string
): string {
  const binDir = path.join(os.tmpdir(), `discord-cc-${threadId}`);
  fs.mkdirSync(binDir, { recursive: true });

  const token = computeLinkerToken(linkerSecret, threadId);
  const scriptPath = path.join(binDir, "gh");

  const lines = [
    "#!/bin/bash",
    `# gh control-plane wrapper for Discord thread ${threadId}`,
    'WRAPPER_DIR="$(cd "$(dirname "$0")" && pwd)"',
    // Resolve the real gh by removing THIS wrapper dir from PATH wherever it
    // appears. A leading-prefix strip (${PATH#$WRAPPER_DIR:}) breaks the moment
    // anything prepends another entry to PATH (e.g. sourcing ~/.local/bin/env):
    // the wrapper dir is no longer first, the strip is a no-op, `command -v gh`
    // resolves back to this wrapper, and `exec "$REAL_GH"` loops forever —
    // spawning a fork storm that surfaces as "fork: Resource temporarily
    // unavailable". Filter every PATH entry and add a self-reference guard.
    'IFS=":" read -ra _PATH_PARTS <<< "$PATH"',
    '_REAL_PATH=""',
    'for _p in "${_PATH_PARTS[@]}"; do',
    '  [ "$_p" = "$WRAPPER_DIR" ] && continue',
    '  _REAL_PATH="${_REAL_PATH:+$_REAL_PATH:}$_p"',
    "done",
    'REAL_GH="$(PATH="$_REAL_PATH" command -v gh 2>/dev/null)"',
    'if [ -z "$REAL_GH" ] || [ "$REAL_GH" -ef "$0" ]; then',
    '  echo "gh: real gh not found in PATH" >&2',
    "  exit 127",
    "fi",
    "",
    "CMD=\"${1:-}\"",
    "SUBCMD=\"${2:-}\"",
    "",
    // Pre-flight: log the command and check policy. Fail-hard if the control
    // server is unreachable so gh failures are visible instead of masked.
    `if ! PREFLIGHT=$(curl -sf --max-time 3 -X POST "http://127.0.0.1:${controlPort}/preflight" \\`,
    `  -H "Authorization: Bearer ${token}" \\`,
    '  -H "Content-Type: application/json" \\',
    `  -d "{\\"threadId\\":\\"${threadId}\\",\\"cmd\\":\\"$CMD\\",\\"subcmd\\":\\"$SUBCMD\\"}"); then`,
    `  echo "gh: control server at 127.0.0.1:${controlPort} not responding" >&2`,
    "  exit 1",
    "fi",
    'if echo "$PREFLIGHT" | grep -q \'"allow":false\'; then',
    '  REASON=$(echo "$PREFLIGHT" | grep -oE \'"reason":"[^"]*"\' | sed \'s/"reason":"//;s/"$//\')',
    '  echo "gh: blocked by policy${REASON:+: $REASON}" >&2',
    "  exit 1",
    "fi",
    "",
    // For gh pr create: capture output to extract the PR URL for linking.
    'if [ "$CMD" = "pr" ] && [ "$SUBCMD" = "create" ]; then',
    '  tmpfile="$(mktemp)"',
    '  "$REAL_GH" "$@" 2>&1 | tee "$tmpfile"; exit_code="${PIPESTATUS[0]}"',
    '  if [ "$exit_code" -eq 0 ]; then',
    "    pr_url=\"$(grep -oE 'https://github\\.com/[^/]+/[^/]+/pull/[0-9]+' \"$tmpfile\" | head -1)\"",
    '    if [ -n "$pr_url" ]; then',
    "      pr_number=\"$(echo \"$pr_url\" | grep -oE '[0-9]+$')\"",
    "      repo=\"$(echo \"$pr_url\" | sed 's|https://github\\.com/||;s|/pull/.*||')\"",
    `      curl -sf --max-time 5 -X POST "http://127.0.0.1:${controlPort}/link-pr" \\`,
    `        -H "Authorization: Bearer ${token}" \\`,
    '        -H "Content-Type: application/json" \\',
    `        -d "{\\"threadId\\":\\"${threadId}\\",\\"repo\\":\\"$repo\\",\\"prNumber\\":$pr_number}" \\`,
    // Don't fail the command — the PR was already created — but make a failed
    // link visible instead of silently dropping it.
    `        >/dev/null 2>&1 || echo "gh: warning: created PR #$pr_number but could not link it to the thread (control server at 127.0.0.1:${controlPort} unreachable)" >&2`,
    "    fi",
    "  fi",
    '  rm -f "$tmpfile"',
    '  exit "$exit_code"',
    "else",
    '  exec "$REAL_GH" "$@"',
    "fi",
  ];

  fs.writeFileSync(scriptPath, lines.join("\n") + "\n", { mode: 0o755 });
  return binDir;
}
