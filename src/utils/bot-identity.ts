import path from "path";
import type { BotRole } from "../types/index.js";

/**
 * A single binary runs as one of these roles. The role is the one switch that
 * distinguishes two co-running instances (e.g. a worker that does the work and a
 * manager that keeps it on-goal and reviews). Everything else — DB file, MCP
 * port, and message routing — is derived from it so a second instance can't be
 * misconfigured into sharing the first instance's state.
 */
export type { BotRole };

/** This instance's role, from BOT_ROLE. Defaults to "worker" (the historical behavior). */
export function getBotRole(): BotRole {
  return (process.env.BOT_ROLE || "worker").toLowerCase() === "manager" ? "manager" : "worker";
}

/**
 * Role-derived SQLite path. Explicit DB_PATH always wins; otherwise the worker
 * keeps the historical `sessions.db` and every other role gets its own file, so
 * two instances never share a DB by accident.
 */
export function resolveDbPath(role: BotRole = getBotRole()): string {
  if (process.env.DB_PATH) return process.env.DB_PATH;
  const file = role === "worker" ? "sessions.db" : `${role}-sessions.db`;
  return path.join(process.cwd(), file);
}

/**
 * Role-derived MCP permission-server port. Explicit MCP_SERVER_PORT always wins;
 * otherwise the worker keeps 3001 and other roles are offset so the two
 * instances don't fight over the port.
 */
export function resolveMcpPort(role: BotRole = getBotRole()): number {
  if (process.env.MCP_SERVER_PORT) return parseInt(process.env.MCP_SERVER_PORT);
  return role === "worker" ? 3001 : 3011;
}

/**
 * The role that answers messages addressed to no specific bot. Set the same
 * DEFAULT_RESPONDER value in both instances' environments to pick which one is
 * the default; defaults to "worker".
 */
export function getDefaultResponderRole(): BotRole {
  return (process.env.DEFAULT_RESPONDER || "worker").toLowerCase() === "manager" ? "manager" : "worker";
}

/** True when this instance is the one that handles un-addressed messages. */
export function isDefaultResponder(role: BotRole = getBotRole()): boolean {
  return getDefaultResponderRole() === role;
}
