import * as fs from "fs";
import * as os from "os";
import * as path from "path";

// World-writable trigger watched by deploy/com.refresh-devbot-creds.plist (WatchPaths).
export const DEFAULT_CREDS_TRIGGER_FILE = "/Users/Shared/devbot-creds-refresh.trigger";

// Path the external refresher watches (WatchPaths). Defaults on macOS so the bot
// does not fall back to a blind 60s wait when the env var is unset.
export const CREDS_TRIGGER_FILE =
  process.env.CREDS_REFRESH_TRIGGER_FILE ||
  (process.platform === "darwin" ? DEFAULT_CREDS_TRIGGER_FILE : undefined);

export const CREDS_FILE = path.join(
  process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), ".claude"),
  ".credentials.json"
);

// Treat tokens expiring within this window as not-yet-fresh.
export const CREDS_FRESH_BUFFER_MS = 60_000;
// How long to wait for the external refresher to produce a fresh token.
export const CREDS_HEAL_TIMEOUT_MS = 90_000;
export const CREDS_HEAL_POLL_MS = 2000;

export function readCredsToken(): { token: string; expiresAt: number } | null {
  try {
    const oauth = JSON.parse(fs.readFileSync(CREDS_FILE, "utf8"))?.claudeAiOauth ?? {};
    if (!oauth.accessToken) return null;
    return { token: oauth.accessToken as string, expiresAt: (oauth.expiresAt as number) ?? 0 };
  } catch {
    return null;
  }
}

export function credsAreFresh(token?: string | null): boolean {
  const c = readCredsToken();
  if (!c) return false;
  if (token != null && c.token === token) return false;
  return c.expiresAt > Date.now() + CREDS_FRESH_BUFFER_MS;
}

// Ask the external refresher to sync a fresh token now by touching the trigger
// file (its WatchPaths fires on the change). No-op when unconfigured.
export function requestCredentialRefresh(): void {
  if (!CREDS_TRIGGER_FILE) return;
  try {
    fs.writeFileSync(CREDS_TRIGGER_FILE, `${Date.now()}\n`);
  } catch (err) {
    console.error(`[oauth-heal] failed to touch trigger ${CREDS_TRIGGER_FILE}:`, err);
  }
}

// Poll the credentials file until a fresh token appears (ideally one that
// differs from the failing token), or the timeout elapses.
export async function waitForFreshCreds(timeoutMs: number, prevToken: string | null): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (credsAreFresh(prevToken)) return true;
    await new Promise((r) => setTimeout(r, CREDS_HEAL_POLL_MS));
  }
  return credsAreFresh(prevToken);
}
