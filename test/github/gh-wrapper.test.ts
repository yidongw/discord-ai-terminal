import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { spawnSync } from "child_process";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { createGhWrapper, computeLinkerToken } from "../../src/github/gh-wrapper.js";

// Build a throwaway "real gh" on a separate bin dir that just echoes a marker,
// so we can tell whether the wrapper resolved through to the real binary or
// recursed back into itself.
function makeFakeGh(dir: string, marker: string): void {
  fs.mkdirSync(dir, { recursive: true });
  const p = path.join(dir, "gh");
  fs.writeFileSync(p, `#!/bin/bash\necho "${marker} $*"\n`, { mode: 0o755 });
}

describe("createGhWrapper", () => {
  let tmpRoot: string;
  let realGhDir: string;
  let binDir: string;

  beforeEach(() => {
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ghwrap-test-"));
    realGhDir = path.join(tmpRoot, "realbin");
    makeFakeGh(realGhDir, "REAL_GH");
    // Wrapper writes into os.tmpdir()/discord-cc-<threadId>; use a unique id.
    binDir = createGhWrapper(`test-${process.pid}-${Date.now()}`, 3999, "secret");
  });

  afterEach(() => {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
    fs.rmSync(binDir, { recursive: true, force: true });
  });

  it("computes a stable HMAC linker token", () => {
    expect(computeLinkerToken("secret", "123")).toBe(computeLinkerToken("secret", "123"));
    expect(computeLinkerToken("secret", "123")).not.toBe(computeLinkerToken("secret", "456"));
  });

  // Regression: a reordered PATH (wrapper dir no longer first) must not make the
  // wrapper resolve back to itself and exec in an infinite loop. Before the fix
  // this hung / fork-bombed; now it must run the real gh exactly once.
  it("resolves the real gh even when its dir is not first on PATH", () => {
    const ghScript = path.join(binDir, "gh");
    const reorderedPath = `/some/prepended/dir:${binDir}:${realGhDir}:/usr/bin:/bin`;

    const result = spawnSync("/bin/bash", [ghScript, "pr", "view", "1"], {
      encoding: "utf8",
      timeout: 8000,
      env: { ...process.env, PATH: reorderedPath },
    });

    // Must terminate (no timeout/recursion) and reach the real gh exactly once.
    expect(result.error).toBeUndefined();
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("REAL_GH pr view 1");
    expect(result.stdout.match(/REAL_GH/g) ?? []).toHaveLength(1);
  });

  it("exits 127 instead of recursing when no real gh exists on PATH", () => {
    const ghScript = path.join(binDir, "gh");
    // PATH has the wrapper dir but no real gh (std dirs only) — the
    // self-reference guard must trip rather than recurse.
    const result = spawnSync("/bin/bash", [ghScript, "pr", "view", "1"], {
      encoding: "utf8",
      timeout: 8000,
      env: { ...process.env, PATH: `${binDir}:/usr/bin:/bin` },
    });

    expect(result.error).toBeUndefined();
    expect(result.status).toBe(127);
    expect(result.stderr).toContain("real gh not found");
  });
});
