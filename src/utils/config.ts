import type { Config } from "../types/index.js";

export function validateConfig(): Config {
  const discordToken = process.env.DISCORD_TOKEN;
  const allowedUserIdsRaw = process.env.ALLOWED_USER_IDS;
  const baseFolder = process.env.BASE_FOLDER;

  if (!discordToken) {
    console.error("DISCORD_TOKEN environment variable is required");
    process.exit(1);
  }
  if (!allowedUserIdsRaw) {
    console.error("ALLOWED_USER_IDS environment variable is required (comma-separated)");
    process.exit(1);
  }
  if (!baseFolder) {
    console.error("BASE_FOLDER environment variable is required");
    process.exit(1);
  }

  const allowedUserIds = allowedUserIdsRaw.split(",").map((id) => id.trim()).filter(Boolean);
  if (allowedUserIds.length === 0) {
    console.error("ALLOWED_USER_IDS must contain at least one user ID");
    process.exit(1);
  }

  const discordAiTerminalChannelId = process.env.DISCORD_AI_TERMINAL || undefined;

  // Parse review bot IDs/usernames (comma-separated list)
  const reviewBotIdsRaw = process.env.REVIEW_BOT_IDS || "";
  const reviewBotIds = reviewBotIdsRaw.split(",").map((id) => id.trim()).filter(Boolean);

  return { discordToken, allowedUserIds, baseFolder, discordAiTerminalChannelId, reviewBotIds };
}
