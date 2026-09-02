import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

describe("oauth-creds-heal", () => {
  let tmpDir: string;
  let credsFile: string;
  let envBackup: NodeJS.ProcessEnv;

  async function loadModule() {
    vi.resetModules();
    return import("../../src/utils/oauth-creds-heal.js");
  }

  beforeEach(() => {
    envBackup = { ...process.env };
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "oauth-heal-"));
    credsFile = path.join(tmpDir, ".credentials.json");
    process.env.CLAUDE_CONFIG_DIR = tmpDir;
    process.env.CREDS_REFRESH_TRIGGER_FILE = path.join(tmpDir, "refresh.trigger");
  });

  afterEach(() => {
    process.env = envBackup;
    fs.rmSync(tmpDir, { recursive: true, force: true });
    vi.resetModules();
  });

  function writeCreds(token: string, expiresAt: number) {
    fs.writeFileSync(
      credsFile,
      JSON.stringify({ claudeAiOauth: { accessToken: token, expiresAt } }, null, 2)
    );
  }

  it("credsAreFresh rejects the same failing token even when not expired", async () => {
    const mod = await loadModule();
    const expiresAt = Date.now() + 3600_000;
    writeCreds("stale-token", expiresAt);
    expect(mod.credsAreFresh("stale-token")).toBe(false);
    expect(mod.credsAreFresh()).toBe(true);
  });

  it("waitForFreshCreds returns true when a different fresh token appears", async () => {
    const mod = await loadModule();
    writeCreds("old-token", Date.now() + 3600_000);

    setTimeout(() => {
      writeCreds("new-token", Date.now() + 3600_000);
    }, 50);

    const healed = await mod.waitForFreshCreds(5000, "old-token");
    expect(healed).toBe(true);
    expect(mod.readCredsToken()?.token).toBe("new-token");
  });

  it("waitForFreshCreds returns false when only the same token is present", async () => {
    const mod = await loadModule();
    writeCreds("same-token", Date.now() + 3600_000);
    const healed = await mod.waitForFreshCreds(300, "same-token");
    expect(healed).toBe(false);
  });

  it("requestCredentialRefresh touches the trigger file", async () => {
    const mod = await loadModule();
    const trigger = process.env.CREDS_REFRESH_TRIGGER_FILE!;
    mod.requestCredentialRefresh();
    expect(fs.existsSync(trigger)).toBe(true);
  });
});
