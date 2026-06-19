export function formatPrMergedMessage(
  prNumber: number,
  prTitle: string,
  mergedBy: string | null,
  prUrl: string
): string {
  const titleStr = prTitle ? ` — ${prTitle}` : "";
  const byStr = mergedBy ? ` by @${mergedBy}` : "";
  return `🔀 Merged PR #${prNumber}${titleStr}${byStr}.\n${prUrl}`;
}

export function formatPrClosedMessage(
  prNumber: number,
  prTitle: string,
  prUrl: string
): string {
  const titleStr = prTitle ? ` — ${prTitle}` : "";
  return `🚫 Closed PR #${prNumber}${titleStr} without merging.\n${prUrl}`;
}

export function formatPrOpenedMessage(prNumber: number, prUrl: string): string {
  return `📎 Opened PR #${prNumber}\n${prUrl}`;
}

export function formatPrNewCommitsMessage(
  prNumber: number,
  shortSha: string,
  prUrl: string
): string {
  return `🔄 New commits pushed to PR #${prNumber}${shortSha}\n${prUrl}`;
}
