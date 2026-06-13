import { DiscordBot } from "./bot/client.js";
import { SessionManager } from "./bot/session-manager.js";
import { Scheduler } from "./bot/scheduler.js";
import { BackgroundJobManager } from "./bot/background-jobs.js";
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

  // Watches detached background commands and re-invokes cc with their output when
  // they finish (completion-driven sibling of the scheduler).
  const bgJobs = new BackgroundJobManager(bot.client, sessionManager, sessionManager.getDb());
  mcpServer.setBackgroundJobManager(bgJobs);

  let shuttingDown = false;
  const shutdown = async () => {
    if (shuttingDown) return; // a second SIGTERM during drain shouldn't re-enter
    shuttingDown = true;
    console.log("Shutting down...");
    try { scheduler.stop(); } catch {}
    try { bgJobs.stop(); } catch {}
    try { await mcpServer.stop(); } catch {}
    // Leave in-flight agents RUNNING (detached). detachAndExit drains whatever is
    // already queued, flushes offsets, and returns; the next boot re-attaches.
    try { await sessionManager.detachAndExit(); } catch {}
    process.exit(0);
  };

  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  await bot.login(config.discordToken);

  // login() resolves before the gateway is READY, but reattach needs to fetch
  // channels — wait for ready first.
  if (!bot.client.isReady()) {
    await new Promise<void>((resolve) => bot.client.once("ready", () => resolve()));
  }

  // Build the GitHub handler (if enabled) and register its completion handler
  // BEFORE reattach, so a PR run that finished while the bot was down still posts
  // its summary when reattach finalizes it.
  const githubEnabled = !!(process.env.GITHUB_WEBHOOK_SECRET || process.env.GITHUB_TOKEN);
  const githubHandler = githubEnabled
    ? new GitHubHandler(bot.client, sessionManager, config.baseFolder)
    : undefined;
  if (githubHandler) {
    sessionManager.setCompletionHandler((action, text) => githubHandler.runCompletionAction(action, text));
    sessionManager.setSessionFinalizeHandler((threadId, workDir, branch) =>
      githubHandler.checkAndLinkPrForBranch(threadId, workDir, branch)
    );
    bot.setGitHubHandler(githubHandler);
  }

  // Re-attach to any runs that survived the last restart BEFORE the scheduler
  // (or an incoming message) can spawn a new run onto the same thread.
  await sessionManager.reattachRuns(bot.client);

  // If /update triggered this restart, send a confirmation to the channel.
  // Interaction reply messages can only be edited via the interaction's webhook
  // token (which doesn't survive restarts), so we send a new message instead.
  const restartNote = sessionManager.getDb().getRestartNotification();
  if (restartNote) {
    sessionManager.getDb().clearRestartNotification();
    try {
      const ch = await bot.client.channels.fetch(restartNote.channelId);
      if (ch?.isTextBased()) {
        const { EmbedBuilder } = await import("discord.js");
        await (ch as any).send({
          embeds: [
            new EmbedBuilder()
              .setTitle("✅ Restart complete")
              .setDescription("Bot is back online.")
              .setColor(0x00ff00),
          ],
        });
      }
    } catch (err) {
      console.error("[update] failed to send restart notification:", err);
    }
  }

  scheduler.start();
  // Resumes watching any background jobs that were running before a restart;
  // ones that finished while the bot was down get detected and wake cc now.
  bgJobs.start();

  if (githubHandler) {
    const webhookServer = new GitHubWebhookServer(githubHandler);
    const webhookPort = parseInt(process.env.GITHUB_WEBHOOK_PORT ?? "3002");
    webhookServer.start(webhookPort);
  }

  console.log("Agent Discord Bot started.");
}

main().catch(console.error);
