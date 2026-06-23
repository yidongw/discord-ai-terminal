import { describe, it, expect, afterEach } from "vitest";
import path from "path";
import {
  getBotRole,
  resolveDbPath,
  resolveMcpPort,
  getDefaultResponderRole,
  isDefaultResponder,
} from "../../src/utils/bot-identity.js";

const ENV_KEYS = ["BOT_ROLE", "DB_PATH", "MCP_SERVER_PORT", "DEFAULT_RESPONDER"] as const;

function clearEnv() {
  for (const k of ENV_KEYS) delete process.env[k];
}

afterEach(clearEnv);

describe("getBotRole", () => {
  it("defaults to worker", () => {
    clearEnv();
    expect(getBotRole()).toBe("worker");
  });

  it("reads BOT_ROLE=manager (case-insensitive)", () => {
    process.env.BOT_ROLE = "Manager";
    expect(getBotRole()).toBe("manager");
  });

  it("treats unknown roles as worker", () => {
    process.env.BOT_ROLE = "supervisor";
    expect(getBotRole()).toBe("worker");
  });
});

describe("resolveDbPath", () => {
  it("worker keeps the historical sessions.db", () => {
    clearEnv();
    expect(resolveDbPath("worker")).toBe(path.join(process.cwd(), "sessions.db"));
  });

  it("manager automatically gets its own file", () => {
    clearEnv();
    expect(resolveDbPath("manager")).toBe(path.join(process.cwd(), "manager-sessions.db"));
  });

  it("explicit DB_PATH always wins", () => {
    process.env.DB_PATH = "/tmp/custom.db";
    expect(resolveDbPath("manager")).toBe("/tmp/custom.db");
    expect(resolveDbPath("worker")).toBe("/tmp/custom.db");
  });
});

describe("resolveMcpPort", () => {
  it("offsets the manager off the worker's port", () => {
    clearEnv();
    expect(resolveMcpPort("worker")).toBe(3001);
    expect(resolveMcpPort("manager")).toBe(3011);
  });

  it("explicit MCP_SERVER_PORT always wins", () => {
    process.env.MCP_SERVER_PORT = "4444";
    expect(resolveMcpPort("manager")).toBe(4444);
  });
});

describe("default responder", () => {
  it("defaults to worker", () => {
    clearEnv();
    expect(getDefaultResponderRole()).toBe("worker");
    expect(isDefaultResponder("worker")).toBe(true);
    expect(isDefaultResponder("manager")).toBe(false);
  });

  it("DEFAULT_RESPONDER=manager flips which instance is default", () => {
    process.env.DEFAULT_RESPONDER = "manager";
    expect(isDefaultResponder("manager")).toBe(true);
    expect(isDefaultResponder("worker")).toBe(false);
  });
});
