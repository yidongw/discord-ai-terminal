#!/usr/bin/env bun
/**
 * End-to-end verification: call claude (cc), parse real stream-json, register wakeup.
 * Usage: bun scripts/verify-session-limit-wakeup.ts
 */
import { spawn } from "child_process";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { parseSdkLine } from "../src/agents/sdk-parser.js";
import { parseSessionLimitReset } from "../src/utils/session-limit-reset.js";
import { DatabaseManager } from "../src/db/database.js";
import {
  SESSION_LIMIT_CONTINUATION_PROMPT,
  registerSessionLimitWakeup,
  sessionLimitTaskId,
} from "../src/bot/session-limit-wakeup.js";

async function callCc(prompt: string): Promise<{ lines: string[]; exitCode: number | null }> {
  return new Promise((resolve, reject) => {
    const proc = spawn(
      "claude",
      ["--output-format", "stream-json", "-p", prompt, "--verbose"],
      { env: { ...process.env, SHELL: "/bin/bash" }, stdio: ["ignore", "pipe", "pipe"] }
    );
    let buf = "";
    const lines: string[] = [];
    const onData = (chunk: Buffer) => {
      buf += chunk.toString();
      let idx: number;
      while ((idx = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, idx).trim();
        buf = buf.slice(idx + 1);
        if (line) lines.push(line);
      }
    };
    proc.stdout!.on("data", onData);
    proc.stderr!.on("data", onData);
    proc.on("error", reject);
    proc.on("close", (code) => resolve({ lines, exitCode: code }));
  });
}

function processCcLines(lines: string[], threadId: string) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "verify-session-limit-"));
  const db = new DatabaseManager(path.join(dir, "verify.db"));

  let resetAt: number | undefined;
  let resetLabel: string | undefined;
  let limitMessage: string | undefined;
  const events: string[] = [];

  for (const line of lines) {
    const event = parseSdkLine(line, process.cwd());
    if (!event) continue;
    events.push(`${event.kind}${"message" in event ? `: ${(event as any).message?.slice(0, 60)}` : ""}`);

    if (event.kind === "rate_limit") {
      resetAt = event.resetAt;
      resetLabel = event.resetLabel;
    }
    if (event.kind === "error") {
      limitMessage = event.message;
      const parsed = parseSessionLimitReset(event.message);
      if (parsed) {
        resetAt = resetAt ?? parsed.resetAt;
        resetLabel = resetLabel ?? parsed.resetLabel;
      }
    }
    if ((event as any).kind === "_sdk_assistant" && (event as any).content) {
      const parsed = parseSessionLimitReset((event as any).content);
      if (parsed) {
        limitMessage = (event as any).content;
        resetAt = resetAt ?? parsed.resetAt;
        resetLabel = resetLabel ?? parsed.resetLabel;
      }
    }
  }

  if (!resetAt) {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
    return { events, limitMessage, resetAt, resetLabel, task: null, stored: null };
  }

  const task = registerSessionLimitWakeup(db, {
    threadId,
    channelId: "verify-channel",
    workDir: process.cwd(),
    userId: "verify-user",
    resetAt,
  });
  const stored = db.getScheduledTask(task.id);
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
  return { events, limitMessage, resetAt, resetLabel, task, stored };
}

async function main() {
  console.log("=== 1. Call Claude Code (cc) ===\n");
  const prompt = "Reply with exactly: pong";
  console.log(`$ claude -p "${prompt}" --output-format stream-json\n`);

  const { lines, exitCode } = await callCc(prompt);
  console.log(`exit code: ${exitCode}`);
  console.log(`stream-json lines: ${lines.length}\n`);

  const threadId = `verify-thread-${Date.now()}`;
  const result = processCcLines(lines, threadId);

  console.log("=== 2. Parsed events ===\n");
  for (const e of result.events) console.log(`  ${e}`);

  if (result.limitMessage) {
    console.log(`\nlimit message: ${result.limitMessage}`);
  }
  if (result.resetAt) {
    console.log(`reset at:      ${new Date(result.resetAt).toLocaleString()} (${result.resetLabel})`);
  }

  console.log(`\nwakeup prompt (sent via --resume at reset time):\n---\n${SESSION_LIMIT_CONTINUATION_PROMPT}\n---`);

  if (result.stored) {
    console.log(`\nregistered task:`);
    console.log(`  id:        ${result.stored.id}`);
    console.log(`  label:     ${result.stored.label}`);
    console.log(`  agent:     ${result.stored.agent}`);
    console.log(`  maxRuns:   ${result.stored.maxRuns}`);
    console.log(`  nextRunAt: ${new Date(result.stored.nextRunAt).toISOString()}`);
    console.log(`  prompt:    ${result.stored.prompt.slice(0, 60)}…`);
  }

  const hitLimit = !!result.limitMessage;
  const falsePositive = !hitLimit && result.stored !== null;

  if (!hitLimit) {
    if (falsePositive) {
      console.log("\n=== Result: FAIL — false positive: wakeup registered without limit hit ===\n");
      process.exit(1);
    }
    console.log("\n=== Result: PASS — normal run, no false wakeup registered ===\n");
    process.exit(0);
  }

  const ok =
    result.stored !== null &&
    result.stored.id === sessionLimitTaskId(threadId) &&
    result.stored.prompt === SESSION_LIMIT_CONTINUATION_PROMPT &&
    result.stored.maxRuns === 1;

  console.log(`\n=== Result: ${ok ? "PASS — wakeup registered from real CC output" : "FAIL"} ===\n`);
  process.exit(ok ? 0 : 1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
