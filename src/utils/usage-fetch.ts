import * as path from "path";
import * as os from "os";

export interface ClaudeUsage {
  fiveHour: number | null;   // 0-100
  fiveHourReset: number | null;  // Unix seconds
  sevenDay: number | null;   // 0-100
  sevenDayReset: number | null;  // Unix seconds
}

const CREDS_PATH = path.join(os.homedir(), ".claude", ".credentials.json");
const KEYCHAIN_SERVICE = "Claude Code-credentials";
const TOKEN_ENDPOINT = "https://platform.claude.com/v1/oauth/token";
const CLIENT_ID = "https://claude.ai/oauth/claude-code-client-metadata";

interface OAuthCreds {
  accessToken: string;
  refreshToken: string;
  expiresAt: number;
}

async function readKeychain(): Promise<OAuthCreds | null> {
  try {
    const proc = Bun.spawn(["security", "find-generic-password", "-s", KEYCHAIN_SERVICE, "-w"], {
      stdout: "pipe",
      stderr: "ignore",
    });
    const raw = await new Response(proc.stdout).text();
    const code = await proc.exited;
    if (code !== 0) return null;
    const creds = JSON.parse(raw.trim());
    const o = creds?.claudeAiOauth;
    if (!o?.accessToken) return null;
    return { accessToken: o.accessToken, refreshToken: o.refreshToken ?? "", expiresAt: o.expiresAt ?? 0 };
  } catch {
    return null;
  }
}

async function readCredFile(): Promise<OAuthCreds | null> {
  try {
    const file = Bun.file(CREDS_PATH);
    const creds = await file.json();
    const o = creds?.claudeAiOauth;
    if (!o?.accessToken) return null;
    return { accessToken: o.accessToken, refreshToken: o.refreshToken ?? "", expiresAt: o.expiresAt ?? 0 };
  } catch {
    return null;
  }
}

async function tryRefreshToken(refreshToken: string): Promise<string | null> {
  if (!refreshToken) return null;
  try {
    const res = await fetch(TOKEN_ENDPOINT, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "refresh_token",
        refresh_token: refreshToken,
        client_id: CLIENT_ID,
      }),
    });
    if (!res.ok) return null;
    const data: any = await res.json();
    return typeof data.access_token === "string" ? data.access_token : null;
  } catch {
    return null;
  }
}

async function getValidToken(): Promise<string | null> {
  const now = Date.now();

  // Keychain first — has the latest token refreshed by the running Claude Code
  const kc = await readKeychain();
  if (kc && kc.expiresAt > now + 60_000) return kc.accessToken;

  // Fall back to file
  const file = await readCredFile();
  if (file) {
    if (file.expiresAt > now + 60_000) return file.accessToken;
    if (file.refreshToken) {
      const fresh = await tryRefreshToken(file.refreshToken);
      if (fresh) return fresh;
    }
  }

  // Last resort: try refresh token from keychain even if access token is stale
  if (kc?.refreshToken) {
    const fresh = await tryRefreshToken(kc.refreshToken);
    if (fresh) return fresh;
  }

  return null;
}

export async function fetchClaudeUsage(): Promise<ClaudeUsage> {
  const empty: ClaudeUsage = { fiveHour: null, fiveHourReset: null, sevenDay: null, sevenDayReset: null };
  const token = await getValidToken();
  if (!token) return empty;

  try {
    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${token}`,
        "anthropic-version": "2023-06-01",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: "claude-haiku-4-5-20251001",
        max_tokens: 1,
        messages: [{ role: "user", content: "." }],
      }),
    });

    const fiveHourStr = res.headers.get("anthropic-ratelimit-unified-5h-utilization");
    const fiveHourResetStr = res.headers.get("anthropic-ratelimit-unified-5h-reset");
    const sevenDayStr = res.headers.get("anthropic-ratelimit-unified-7d-utilization");
    const sevenDayResetStr = res.headers.get("anthropic-ratelimit-unified-7d-reset");

    return {
      fiveHour: fiveHourStr != null ? Math.round(parseFloat(fiveHourStr) * 100) : null,
      fiveHourReset: fiveHourResetStr != null ? parseInt(fiveHourResetStr, 10) : null,
      sevenDay: sevenDayStr != null ? Math.round(parseFloat(sevenDayStr) * 100) : null,
      sevenDayReset: sevenDayResetStr != null ? parseInt(sevenDayResetStr, 10) : null,
    };
  } catch {
    return empty;
  }
}

// Format seconds remaining into a compact human-readable string:
// < 1h → "45m", < 24h → "2h 30m", ≥ 24h → "2d 4h"
export function formatTimeLeft(resetAtSecs: number): string {
  const secsLeft = Math.max(0, resetAtSecs - Date.now() / 1000);
  const mins = Math.floor(secsLeft / 60);
  if (mins < 60) return `${mins}m`;
  const hours = Math.floor(secsLeft / 3600);
  const remMins = Math.floor((secsLeft % 3600) / 60);
  if (hours < 24) return remMins > 0 ? `${hours}h ${remMins}m` : `${hours}h`;
  const days = Math.floor(hours / 24);
  const remHours = hours % 24;
  return remHours > 0 ? `${days}d ${remHours}h` : `${days}d`;
}
