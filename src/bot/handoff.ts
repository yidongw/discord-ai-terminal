/** Derive the handoff target name from the Discord bot that sent the message. */
export function handoffBotNameFromAuthor(author: { username: string }): string {
  return author.username;
}

export function handoffDoneDescription(
  statsLine: string,
  summary: string,
  handoffBot: string,
  threadAgent: string
): string {
  const lines = [
    statsLine || "Complete.",
    "",
    summary,
    "",
    `@${handoffBot} — Please review the above and provide next steps or mark as complete. Use @${threadAgent} to continue.`,
  ];
  return lines.join("\n");
}

/** Truncate assistant output for the Done embed summary field. */
export function summarizeForHandoff(text: string, maxLen = 1500): string {
  const trimmed = text.trim();
  if (!trimmed) return "Work completed.";
  if (trimmed.length <= maxLen) return trimmed;
  return trimmed.slice(0, maxLen - 1) + "…";
}
