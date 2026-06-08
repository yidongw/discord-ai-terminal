import { DiscordBot } from "./bot/client.js";
import { SessionManager } from "./bot/session-manager.js";
import { Scheduler } from "./bot/scheduler.js";
import { validateConfig } from "./utils/config.js";
import { MCPPermissionServer } from "./mcp/server.js";
import { GitHubHandler } from "./github/handler.js";
import { GitHubWebhookServer } from "./github/webhook.js";

async function main() {
  const config = validateConfig();

  const mcpPort = parseInt(process.env.MCP_SERVER_PORT || "3001");
  const mcpServer = new MCPPermissionServer(mcpPort);
  await mcpServer.start();

  const sessionManager = new SessionManager();
  // Share the one DB instance so schedule_task tools persist into the same
  // sessions the scheduler and bot read from.
  mcpServer.setDb(sessionManager.getDb());

  const bot = new DiscordBot(sessionManager, config.allowedUserIds, config.baseFolder);
  bot.setMCPServer(mcpServer);

  // The scheduler is the durable timer that replays recurring tasks: it survives
  // between (disposable) agent runs and re-invokes them through runAgent().
  const scheduler = new Scheduler(bot.client, sessionManager, sessionManager.getDb());

  const shutdown = async () => {
    console.log("Shutting down...");
    try { scheduler.stop(); } catch {}
    try { await mcpServer.stop(); } catch {}
    try { sessionManager.destroy(); } catch {}
    process.exit(0);
  };

  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  await bot.login(config.discordToken);
  scheduler.start();

  if (process.env.GITHUB_WEBHOOK_SECRET || process.env.GITHUB_TOKEN) {
    const githubHandler = new GitHubHandler(bot.client, sessionManager, config.baseFolder);
    const webhookServer = new GitHubWebhookServer(githubHandler);
    const webhookPort = parseInt(process.env.GITHUB_WEBHOOK_PORT ?? "3002");
    webhookServer.start(webhookPort);
  }

  console.log("Agent Discord Bot started.");
}

main().catch(console.error);
