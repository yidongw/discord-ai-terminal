import { DiscordBot } from "./bot/client.js";
import { SessionManager } from "./bot/session-manager.js";
import { validateConfig } from "./utils/config.js";
import { MCPPermissionServer } from "./mcp/server.js";

async function main() {
  const config = validateConfig();

  const mcpPort = parseInt(process.env.MCP_SERVER_PORT || "3001");
  const mcpServer = new MCPPermissionServer(mcpPort);
  await mcpServer.start();

  const sessionManager = new SessionManager();
  const bot = new DiscordBot(sessionManager, config.allowedUserIds, config.baseFolder);

  bot.setMCPServer(mcpServer);

  const shutdown = async () => {
    console.log("Shutting down...");
    try { await mcpServer.stop(); } catch {}
    try { sessionManager.destroy(); } catch {}
    process.exit(0);
  };

  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  await bot.login(config.discordToken);
  console.log("Agent Discord Bot started.");
}

main().catch(console.error);
