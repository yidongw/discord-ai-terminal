import { DiscordBot } from "./bot/client.js";
import { GatewayWatchdog } from "./bot/gateway-watchdog.js";
import { SessionManager } from "./bot/session-manager.js";
import { Scheduler } from "./bot/scheduler.js";
import { BackgroundJobManager } from "./bot/background-jobs.js";
import { validateConfig } from "./utils/config.js";
import { resolveMcpPort } from "./utils/bot-identity.js";
import { MCPPermissionServer } from "./mcp/server.js";
import { GitHubHandler } from "./github/handler.js";
import { GitHubWebhookServer, registerGitHubWebhook } from "./github/webhook.js";

// Worker mode: runs as a headless single-message bot for one discord-ai-terminal
// thread. Triggered when the main bot spawns us from the thread's own worktree.
if (process.env.DISCORD_AI_TERMINAL_THREAD_ID) {
  const { runWorkerMode } = await import("./bot/worker-mode.js");
  await runWorkerMode();
  process.exit(0);
}

async function main() {
  const config = validateConfig();

  console.log(`Starting as role="${config.botRole}" (default responder: ${config.isDefaultResponder})`);

  // Port is role-derived so a second instance doesn't collide on 3001.
  const mcpPort = resolveMcpPort(config.botRole);
  const mcpServer = new MCPPermissionServer(mcpPort);
  await mcpServer.start();

  const sessionManager = new SessionManager();
  // Share the one DB instance so schedule_task tools persist into the same
  // sessions the scheduler and bot read from.
  mcpServer.setDb(sessionManager.getDb());

  const bot = new DiscordBot(sessionManager, config.allowedUserIds, config.baseFolder, config.discordAiTerminalChannelId, config.reviewBotIds, config.isDefaultResponder);
  bot.setMCPServer(mcpServer);

  // The scheduler is the durable timer that replays recurring tasks: it survives
  // between (disposable) agent runs and re-invokes them through runAgent().
  const scheduler = new Scheduler(bot.client, sessionManager, sessionManager.getDb());

  // Watches detached background commands and re-invokes cc with their output when
  // they finish (completion-driven sibling of the scheduler).
  const bgJobs = new BackgroundJobManager(bot.client, sessionManager, sessionManager.getDb());
  mcpServer.setBackgroundJobManager(bgJobs);

  // Restarts the process if the Discord gateway wedges (see GatewayWatchdog).
  // Created after the gateway is READY below; declared here so shutdown can stop it.
  let watchdog: GatewayWatchdog | undefined;

  let shuttingDown = false;
  const shutdown = async () => {
    if (shuttingDown) return; // a second SIGTERM during drain shouldn't re-enter
    shuttingDown = true;
    console.log("Shutting down...");
    try { watchdog?.stop(); } catch {}
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

  // Now that the gateway is up, guard it: if it later disconnects and can't
  // recover, exit so launchd/systemd KeepAlive restarts us with a fresh
  // connection instead of leaving a half-up process the health server masks.
  watchdog = new GatewayWatchdog(bot.client);
  watchdog.start();

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

  // Replay user messages that arrived in known threads while the bot was down.
  await bot.recoverMissedMessages();

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

    // gh control plane: localhost-only server that gh wrapper scripts call
    // before and after every gh invocation to log commands, enforce policy,
    // and link new PRs to the thread that created them.
    // Falls back to GITHUB_WEBHOOK_SECRET so no extra env var is needed when
    // the webhook secret is already configured.
    const linkerSecret =
      process.env.GITHUB_PR_LINKER_SECRET ?? process.env.GITHUB_WEBHOOK_SECRET ?? "";
    if (linkerSecret) {
      const { GhControlServer } = await import("./github/gh-control-server.js");
      const linkerPort = parseInt(process.env.GITHUB_PR_LINKER_PORT ?? "3003");
      // Export back to env so spawned worker processes see the same port even
      // if the operator didn't set GITHUB_PR_LINKER_PORT explicitly.
      process.env.GITHUB_PR_LINKER_PORT = String(linkerPort);
      process.env.GITHUB_PR_LINKER_SECRET = linkerSecret;
      const controlServer = new GhControlServer(githubHandler, linkerSecret);
      controlServer.start(linkerPort);
      sessionManager.setGhLinkerConfig(linkerPort, linkerSecret);
    }

    const webhookUrl = process.env.GITHUB_WEBHOOK_URL;
    const repos = (process.env.GITHUB_WEBHOOK_REPOS ?? "")
      .split(",").map((s) => s.trim()).filter(Boolean);
    if (webhookUrl && repos.length > 0) {
      for (const repo of repos) {
        registerGitHubWebhook(repo, webhookUrl).catch((err) =>
          console.error(`[webhook] register failed for ${repo}:`, err)
        );
      }
    } else if (repos.length > 0) {
      console.warn("[webhook] GITHUB_WEBHOOK_URL not set — skipping GitHub webhook registration");
    }
  }

  console.log("Agent Discord Bot started.");
}

main().catch(console.error);
