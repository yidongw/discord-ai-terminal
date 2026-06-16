import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { DatabaseManager } from "../../src/db/database.js";
import { resolveResumeSessionId } from "../../src/utils/models.js";
import { buildClaudeCommand } from "../../src/utils/shell.js";

/**
 * Mirrors the model + resume resolution in SessionManager.runAgent so we can
 * verify the /model-in-thread flow against a real sqlite DB.
 */
function resolveRunLikeSessionManager(
  db: DatabaseManager,
  threadId: string,
  agentKey: string,
  channelId: string,
  channelDefault: string,
  opts?: { modelOverride?: string }
) {
  let existing = db.getThreadSession(threadId);

  let effectiveModelOverride = opts?.modelOverride ?? existing?.modelOverride;
  if (effectiveModelOverride === undefined) {
    effectiveModelOverride = channelDefault;
    if (existing?.modelOverride === undefined) {
      db.updateModelOverride(threadId, channelDefault);
      if (existing) existing = { ...existing, modelOverride: channelDefault, sessionId: undefined };
    }
  } else if (existing && effectiveModelOverride !== existing.modelOverride) {
    db.updateModelOverride(threadId, effectiveModelOverride);
    existing = { ...existing, modelOverride: effectiveModelOverride, sessionId: undefined };
  }

  const requestedModel = effectiveModelOverride;
  const resumeSessionId = resolveResumeSessionId(existing, agentKey, requestedModel);
  return { requestedModel, resumeSessionId, existing: db.getThreadSession(threadId) };
}

describe("thread /model switch (sqlite integration)", () => {
  let dir: string;
  let db: DatabaseManager;
  const threadId = "thread-model-test";
  const channelId = "channel-1";

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "model-switch-db-"));
    db = new DatabaseManager(path.join(dir, "test.db"));
    db.createThreadSession({
      threadId,
      channelId,
      agent: "cc",
      sessionId: "claude-session-abc",
      workDir: "/tmp/work",
      isWorktree: true,
      createdAt: Date.now(),
      modelOverride: "claude-sonnet-4-6",
      lastRunModel: "claude-sonnet-4-6",
    });
  });

  afterEach(() => {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
  });

  it("clears session_id when /model changes the thread override", () => {
    db.updateModelOverride(threadId, "claude-opus-4-7");
    const session = db.getThreadSession(threadId)!;
    expect(session.modelOverride).toBe("claude-opus-4-7");
    expect(session.sessionId).toBeUndefined();
  });

  it("does not resume after /model — builds a fresh claude command with the new model", () => {
    // User runs /model cc claude-opus-4-7 in the thread
    db.updateModelOverride(threadId, "claude-opus-4-7");

    const { requestedModel, resumeSessionId } = resolveRunLikeSessionManager(
      db,
      threadId,
      "cc",
      channelId,
      "claude-sonnet-4-6"
    );

    expect(requestedModel).toBe("claude-opus-4-7");
    expect(resumeSessionId).toBeUndefined();

    const command = buildClaudeCommand(
      "/tmp/work",
      "follow up",
      resumeSessionId,
      { channelId: threadId, channelName: "test", userId: "u1" },
      "auto",
      requestedModel
    );
    expect(command).toContain("--model claude-opus-4-7");
    expect(command).not.toContain("--resume");
  });

  it("still resumes when the model is unchanged", () => {
    const { requestedModel, resumeSessionId } = resolveRunLikeSessionManager(
      db,
      threadId,
      "cc",
      channelId,
      "claude-sonnet-4-6"
    );

    expect(requestedModel).toBe("claude-sonnet-4-6");
    expect(resumeSessionId).toBe("claude-session-abc");

    const command = buildClaudeCommand(
      "/tmp/work",
      "follow up",
      resumeSessionId,
      { channelId: threadId, channelName: "test", userId: "u1" },
      "auto",
      requestedModel
    );
    expect(command).toContain("--resume claude-session-abc");
    expect(command).toContain("--model claude-sonnet-4-6");
  });

  it("records last_run_model after init so a later /model blocks resume", () => {
    db.updateLastRunModel(threadId, "claude-sonnet-4-6");
    db.updateModelOverride(threadId, "claude-opus-4-7");

    const session = db.getThreadSession(threadId)!;
    const resumeSessionId = resolveResumeSessionId(session, "cc", "claude-opus-4-7");
    expect(resumeSessionId).toBeUndefined();
  });
});
