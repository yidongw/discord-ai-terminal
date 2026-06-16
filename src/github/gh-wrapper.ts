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
//   3. Post-flight – for `gh pr create`, POSTs the new PR URL to /gh-result
//      so the control server can link the PR to this thread immediately,
//      before any GitHub webhook fires.
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
    'WRAPPER_DIR="$(dirname "$0")"',
    'REAL_GH="$(PATH="${PATH#$WRAPPER_DIR:}" command -v gh 2>/dev/null)"',
    'if [ -z "$REAL_GH" ]; then',
    '  echo "gh: real gh not found in PATH" >&2',
    "  exit 127",
    "fi",
    "",
    "CMD=\"${1:-}\"",
    "SUBCMD=\"${2:-}\"",
    "",
    // Pre-flight: log the command and check policy. Fail-open on curl error or
    // server timeout so gh still works if the bot process is temporarily down.
    `PREFLIGHT=$(curl -sf --max-time 3 -X POST "http://127.0.0.1:${controlPort}/preflight" \\`,
    `  -H "Authorization: Bearer ${token}" \\`,
    '  -H "Content-Type: application/json" \\',
    `  -d "{\\"threadId\\":\\"${threadId}\\",\\"cmd\\":\\"$CMD\\",\\"subcmd\\":\\"$SUBCMD\\"}" 2>/dev/null || echo '{"allow":true}')`,
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
    `      curl -sf --max-time 5 -X POST "http://127.0.0.1:${controlPort}/gh-result" \\`,
    `        -H "Authorization: Bearer ${token}" \\`,
    '        -H "Content-Type: application/json" \\',
    `        -d "{\\"threadId\\":\\"${threadId}\\",\\"cmd\\":\\"pr\\",\\"subcmd\\":\\"create\\",\\"prUrl\\":\\"$pr_url\\"}" \\`,
    "        >/dev/null 2>&1 || true",
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
