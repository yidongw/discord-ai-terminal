#!/usr/bin/env bun
/**
 * Manual verification of the zombie typing fix. Run with:
 *   bun scripts/verify-typing-zombie-fix.ts
 */
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { RunTailer, LOG_STALL_TIMEOUT_MS } from "../src/bot/run-tailer.js";
import { TypingIndicator } from "../src/bot/session-manager.js";

const wait = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

let passed = 0;
let failed = 0;

function ok(name: string) {
  passed++;
  console.log(`  ✓ ${name}`);
}

function fail(name: string, detail: string) {
  failed++;
  console.error(`  ✗ ${name}: ${detail}`);
}

async function testStallFinalizesHungRun() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "verify-stall-"));
  const logPath = path.join(dir, "run.jsonl");
  fs.writeFileSync(logPath, '{"type":"assistant","message":{"content":[{"type":"text","text":"hi"}]}}\n');

  let finalized = false;
  let alive = true;
  const tailer = new RunTailer({
    logPath,
    startOffset: 0,
    pollIntervalMs: 20,
    stallTimeoutMs: 100,
    isAlive: () => alive,
    onLine: () => {},
    onOffset: () => {},
    onFinalize: () => { finalized = true; },
  });

  tailer.start();
  await wait(50);
  if (finalized) {
    fail("stall finalizes hung run", "finalized too early");
    return;
  }
  await wait(120);
  if (!finalized) {
    fail("stall finalizes hung run", "never finalized");
    return;
  }
  ok("stall finalizes hung run while process still alive");
  alive = false;
  tailer.stop();
  fs.rmSync(dir, { recursive: true, force: true });
}

async function testTypingStopsOnAbandon() {
  let typingCalls = 0;
  const thread = {
    sendTyping: () => {
      typingCalls++;
      return Promise.resolve();
    },
  };
  const typing = new TypingIndicator(thread, 50);
  typing.start();
  await wait(60);
  const beforeAbandon = typingCalls;
  if (beforeAbandon < 2) {
    fail("typing refreshes while active", `only ${beforeAbandon} calls`);
    return;
  }
  typing.stop();
  await wait(200);
  if (typingCalls !== beforeAbandon) {
    fail("typing stops on abandon", `calls grew from ${beforeAbandon} to ${typingCalls}`);
    return;
  }
  ok("typing stops after abandon (no more sendTyping)");
}

async function testBotRepoWorktreeDetection() {
  const workDir = path.resolve(import.meta.dir, "..");
  const clientTs = path.join(workDir, "src", "bot", "client.ts");
  if (!fs.existsSync(clientTs)) {
    fail("bot repo worktree detection", `missing ${clientTs}`);
    return;
  }
  ok("this checkout is a bot-repo worktree (would route through workers)");
}

async function main() {
  console.log("verify-typing-zombie-fix\n");
  console.log(`LOG_STALL_TIMEOUT_MS = ${LOG_STALL_TIMEOUT_MS} (${LOG_STALL_TIMEOUT_MS / 60000} min)\n`);

  await testStallFinalizesHungRun();
  await testTypingStopsOnAbandon();
  await testBotRepoWorktreeDetection();

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
