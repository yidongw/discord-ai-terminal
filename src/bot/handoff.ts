/** Derive the handoff target name from the Discord bot that sent the message. */
export function handoffBotNameFromAuthor(author: { username: string }): string {
  return author.username;
}

export interface HandoffIdleContext {
  handoffBot?: string;
  queueLength: number;
  hasPendingPostRunPrompt: boolean;
  usageLimitWaiting: boolean;
  pendingUsageLimitResume: boolean;
  pendingTurnLimitResume: boolean;
  hasEnabledScheduledTasks: boolean;
}

/** True when the thread is going fully idle and the Done embed should @-mention handoff. */
export function shouldSendHandoffDone(ctx: HandoffIdleContext): boolean {
  if (!ctx.handoffBot) return false;
  if (ctx.queueLength > 0) return false;
  if (ctx.hasPendingPostRunPrompt) return false;
  if (ctx.usageLimitWaiting) return false;
  if (ctx.pendingUsageLimitResume || ctx.pendingTurnLimitResume) return false;
  if (ctx.hasEnabledScheduledTasks) return false;
  return true;
}

/** Embed body for handoff Done — stats and summary only (mentions don't ping in embeds). */
export function handoffDoneEmbedDescription(statsLine: string, summary: string): string {
  return [statsLine || "Complete.", "", summary].join("\n");
}

/** Message content with a real Discord mention so the handoff bot gets notified. */
export function handoffDoneContent(
  handoffBot: string,
  threadAgent: string,
  handoffBotId?: string
): string {
  const mention = handoffBotId ? `<@${handoffBotId}>` : `@${handoffBot}`;
  return `${mention} — Please review the above and provide next steps or mark as complete. Use @${threadAgent} to continue.`;
}

/** Resolve a stored handoff bot username to a user ID when we don't have one yet. */
export function resolveHandoffBotId(
  guild: { members: { cache: { find: (fn: (m: { user: { id: string; username: string; bot: boolean } }) => boolean) => { user: { id: string } } | undefined } } } | null | undefined,
  handoffBot: string,
  storedId?: string
): string | undefined {
  if (storedId) return storedId;
  if (!guild) return undefined;
  const lower = handoffBot.toLowerCase();
  const member = guild.members.cache.find(
    (m) => m.user.bot && m.user.username.toLowerCase() === lower
  );
  return member?.user.id;
}

/** Truncate assistant output for the Done embed summary field. */
export function summarizeForHandoff(text: string, maxLen = 1500): string {
  const trimmed = text.trim();
  if (!trimmed) return "Work completed.";
  if (trimmed.length <= maxLen) return trimmed;
  return trimmed.slice(0, maxLen - 1) + "…";
}
