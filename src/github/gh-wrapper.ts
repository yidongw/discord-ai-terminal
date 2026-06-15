import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import * as crypto from "crypto";

// HMAC token that the gh wrapper sends to authenticate link-pr requests.
// Derived from the shared secret + threadId so the server can verify without
// a per-thread secret store.
export function computeLinkerToken(secret: string, threadId: string): string {
  return crypto.createHmac("sha256", secret).update(threadId).digest("hex");
}

// Create a temporary bin directory for the thread and write a `gh` wrapper
// script inside it. The wrapper intercepts `gh pr create`, captures the PR URL
// from the output, and notifies the bot's local PR linker server so the PR is
// linked to this thread immediately — before any GitHub webhook fires.
//
// Returns the bin directory path to be prepended to the agent's PATH.
export function createGhWrapper(
  threadId: string,
  linkerPort: number,
  linkerSecret: string
): string {
  const binDir = path.join(os.tmpdir(), `discord-cc-${threadId}`);
  fs.mkdirSync(binDir, { recursive: true });

  const token = computeLinkerToken(linkerSecret, threadId);
  const scriptPath = path.join(binDir, "gh");

  // Shell lines that don't reference TypeScript variables use plain strings.
  // Lines that embed threadId/linkerPort/token use template literals.
  const lines = [
    "#!/bin/bash",
    `# gh wrapper for Discord thread ${threadId}`,
    'WRAPPER_DIR="$(dirname "$0")"',
    // Temporarily strip the wrapper dir from PATH so command -v finds the real gh.
    'REAL_GH="$(PATH="${PATH#$WRAPPER_DIR:}" command -v gh 2>/dev/null)"',
    'if [ -z "$REAL_GH" ]; then',
    '  echo "gh: real gh not found in PATH" >&2',
    "  exit 127",
    "fi",
    // Only intercept pr create; pass everything else straight through.
    'if [[ "${1:-}" == "pr" ]] && [[ "${2:-}" == "create" ]]; then',
    '  tmpfile="$(mktemp)"',
    // Merge stderr into stdout so error text also shows in the terminal via tee.
    '  "$REAL_GH" "$@" 2>&1 | tee "$tmpfile"; exit_code="${PIPESTATUS[0]}"',
    '  if [ "$exit_code" -eq 0 ]; then',
    "    pr_url=\"$(grep -oE 'https://github\\.com/[^/]+/[^/]+/pull/[0-9]+' \"$tmpfile\" | head -1)\"",
    '    if [ -n "$pr_url" ]; then',
    "      pr_number=\"$(echo \"$pr_url\" | grep -oE '[0-9]+$')\"",
    "      repo=\"$(echo \"$pr_url\" | sed 's|https://github\\.com/||;s|/pull/.*||')\"",
    `      curl -sf -X POST "http://127.0.0.1:${linkerPort}/link-pr" \\`,
    `        -H "Authorization: Bearer ${token}" \\`,
    '        -H "Content-Type: application/json" \\',
    // threadId is baked in at wrapper-creation time; repo/pr_number come from shell.
    `        -d "{\\"threadId\\":\\"${threadId}\\",\\"repo\\":\\"$repo\\",\\"prNumber\\":$pr_number}" \\`,
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
