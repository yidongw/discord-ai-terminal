import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { spawnSync, spawn, type ChildProcess } from "child_process";
import { connect } from "net";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { createGhWrapper, computeLinkerToken } from "../../src/github/gh-wrapper.js";

let controlPort: number;

// The wrapper shells out to curl and we drive it through spawnSync, which blocks
// this process's event loop — so an in-process http server could never answer.
// Run the allow-everything stub in a separate process instead.
function startStubControlServer(port: number): ChildProcess {
  const code =
    "require('http').createServer((q,r)=>{" +
    "r.writeHead(200,{'Content-Type':'application/json'});" +
    'r.end(\'{"allow":true}\')' +
    `}).listen(${port},'127.0.0.1',function(){process.stdout.write(String(this.address().port)+"\\n")})`;
  return spawn(process.execPath, ["-e", code], { stdio: ["ignore", "pipe", "ignore"] });
}

async function waitForPort(port: number, timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const ok = await new Promise<boolean>((resolve) => {
      const sock = connect(port, "127.0.0.1");
      sock.once("connect", () => {
        sock.destroy();
        resolve(true);
      });
      sock.once("error", () => resolve(false));
    });
    if (ok) return;
    if (Date.now() > deadline) throw new Error(`stub server on ${port} never came up`);
    await new Promise((r) => setTimeout(r, 50));
  }
}

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
  let controlServer: ChildProcess;

  beforeEach(async () => {
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ghwrap-test-"));
    realGhDir = path.join(tmpRoot, "realbin");
    makeFakeGh(realGhDir, "REAL_GH");
    // Wrapper writes into os.tmpdir()/discord-cc-<threadId>; use a unique id.

    // The wrapper now fails fast if the control server is unreachable, so stand
    // up a stub that allows every command for the resolution tests.
    controlServer = startStubControlServer(0);
    controlPort = await new Promise<number>((resolve) => {
      controlServer.stdout!.once("data", (data) => resolve(Number(data.toString().trim())));
    });
    await waitForPort(controlPort);
    binDir = createGhWrapper(`test-${process.pid}-${Date.now()}`, controlPort, "secret");
  });

  afterEach(() => {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
    fs.rmSync(binDir, { recursive: true, force: true });
    controlServer.kill();
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

  // Fail-fast: when the control server is unreachable the wrapper must surface a
  // clear error and exit non-zero, never silently fall through to the real gh.
  it("fails fast when the control server is unreachable", async () => {
    await new Promise<void>((resolve) => {
      controlServer.once("exit", () => resolve());
      controlServer.kill();
    });
    const deadPortBinDir = createGhWrapper(
      `test-dead-${process.pid}-${Date.now()}`,
      controlPort, // our server has exited
      "secret"
    );
    try {
      const ghScript = path.join(deadPortBinDir, "gh");
      const result = spawnSync("/bin/bash", [ghScript, "pr", "view", "1"], {
        encoding: "utf8",
        timeout: 8000,
        env: { ...process.env, PATH: `${realGhDir}:/usr/bin:/bin` },
      });

      expect(result.error).toBeUndefined();
      expect(result.status).toBe(1);
      expect(result.stderr).toContain(`control server at 127.0.0.1:${controlPort} not responding`);
      // Must not have reached the real gh.
      expect(result.stdout).not.toContain("REAL_GH");
    } finally {
      fs.rmSync(deadPortBinDir, { recursive: true, force: true });
    }
  });

  it("exits 127 instead of recursing when no real gh exists on PATH", () => {
    const ghScript = path.join(binDir, "gh");
    const utilities = path.join(tmpRoot, "utilities");
    fs.mkdirSync(utilities);
    for (const tool of ["dirname"]) fs.symlinkSync(`/usr/bin/${tool}`, path.join(utilities, tool));
    // PATH has the wrapper dir but no real gh (std dirs only) — the
    // self-reference guard must trip rather than recurse.
    const result = spawnSync("/bin/bash", [ghScript, "pr", "view", "1"], {
      encoding: "utf8",
      timeout: 8000,
      env: { ...process.env, PATH: `${binDir}:${utilities}` },
    });

    expect(result.error).toBeUndefined();
    expect(result.status).toBe(127);
    expect(result.stderr).toContain("real gh not found");
  });
});
