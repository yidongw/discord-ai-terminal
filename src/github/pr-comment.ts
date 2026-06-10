const GITHUB_API = "https://api.github.com";

// Prefer GITHUB_PAT (a real user's fine-grained PAT) over GITHUB_TOKEN so that
// trigger comments we post (/cc fix:) are authored by a user — this is what lets
// them fire carbon's agent-trigger.yml and pass the bot's Bot-author loop guard.
function githubToken(): string | undefined {
  return process.env.GITHUB_PAT || process.env.GITHUB_TOKEN;
}

export async function postPrComment(repo: string, prNumber: number, body: string): Promise<void> {
  const token = githubToken();
  if (!token) {
    console.error("[github] no GITHUB_PAT/GITHUB_TOKEN set, skipping PR comment");
    return;
  }

  const res = await fetch(`${GITHUB_API}/repos/${repo}/issues/${prNumber}/comments`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      Accept: "application/vnd.github+json",
    },
    body: JSON.stringify({ body }),
  });

  if (!res.ok) {
    console.error(`[github] Failed to post PR comment: ${res.status} ${await res.text()}`);
  }
}

export async function getPr(repo: string, prNumber: number): Promise<{ title: string; body: string; head: { ref: string }; merged: boolean; state: string } | null> {
  const token = githubToken();
  const headers: Record<string, string> = {
    Accept: "application/vnd.github+json",
  };
  if (token) headers.Authorization = `Bearer ${token}`;

  const res = await fetch(`${GITHUB_API}/repos/${repo}/pulls/${prNumber}`, { headers });
  if (!res.ok) {
    console.error(`[github] Failed to fetch PR: ${res.status}`);
    return null;
  }
  return res.json() as any;
}

export async function getPrComments(
  repo: string,
  prNumber: number
): Promise<Array<{ id: number; body: string }>> {
  const token = githubToken();
  const headers: Record<string, string> = { Accept: "application/vnd.github+json" };
  if (token) headers.Authorization = `Bearer ${token}`;

  const res = await fetch(
    `${GITHUB_API}/repos/${repo}/issues/${prNumber}/comments?per_page=100`,
    { headers }
  );
  if (!res.ok) {
    console.error(`[github] Failed to fetch PR comments: ${res.status}`);
    return [];
  }
  return res.json() as any;
}

// Parse the "## Test plan" section from a PR description.
// Returns the bullet items, or null if no test plan section exists.
export function parseTestPlanFromBody(body: string): string[] | null {
  // Split on section boundaries so we don't bleed into adjacent ## sections.
  const sections = body.split(/\n(?=##\s)/);
  const testSection = sections.find((s) => /^##\s*test\s+plan/i.test(s));
  if (!testSection) return null;
  const items = testSection
    .split("\n")
    .slice(1) // skip the "## Test plan" heading line
    .filter((l) => /^[-*]\s/.test(l)) // only actual list items
    .map((l) => l.replace(/^[-*]\s*(?:\[[ xX]\]\s*)?/, "").trim()) // strip bullets and GH task-list checkboxes
    .filter(Boolean);
  return items.length > 0 ? items : null;
}

export async function getPrCommits(
  repo: string,
  prNumber: number
): Promise<Array<{ sha: string; commit: { message: string } }>> {
  const token = githubToken();
  const headers: Record<string, string> = { Accept: "application/vnd.github+json" };
  if (token) headers.Authorization = `Bearer ${token}`;

  const res = await fetch(
    `${GITHUB_API}/repos/${repo}/pulls/${prNumber}/commits?per_page=50`,
    { headers }
  );
  if (!res.ok) {
    console.error(`[github] Failed to fetch PR commits: ${res.status}`);
    return [];
  }
  return res.json() as any;
}

// Derive the preview URL for a PR. Repos can override via PREVIEW_URL_PATTERN=https://app-pr-{n}.example.com
export function buildPreviewUrl(repo: string, prNumber: number): string {
  const pattern = process.env.PREVIEW_URL_PATTERN;
  if (pattern) return pattern.replace("{n}", String(prNumber));
  const repoName = repo.split("/")[1] ?? repo;
  return `https://erp-pr-${prNumber}.foxhole.bot`;
}

// Extract items that already PASS from bot-posted test summary comments.
export function extractPassedItems(comments: Array<{ body: string }>): Set<string> {
  const passed = new Set<string>();
  for (const comment of comments) {
    const body = comment.body;
    if (!/test result — PR #/i.test(body) && !/STATUS:/i.test(body)) continue;
    const findingsIdx = body.indexOf("FINDINGS:");
    if (findingsIdx === -1) continue;
    const afterFindings = body.slice(findingsIdx + "FINDINGS:".length);
    for (const line of afterFindings.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("Test plan:") || trimmed.startsWith("/cc")) break;
      const match = trimmed.match(/^[-*]\s+(.+?)\s+—\s+PASS(?:\s+—|$)/i);
      if (match?.[1]) passed.add(match[1].trim().toLowerCase());
    }
  }
  return passed;
}

// Extract the failed items from the most recent test summary comment with STATUS: FAIL.
export function extractLastFailedItems(comments: Array<{ body: string }>): string[] {
  for (let i = comments.length - 1; i >= 0; i--) {
    const body = comments[i]!.body;
    if (!/STATUS:\s*FAIL/i.test(body)) continue;
    return extractTestPlanFromComment(body) ?? [];
  }
  return [];
}

// Extract the "Test plan:" block from a bot-posted test summary comment.
// Returns the item list, or null if not found.
export function extractTestPlanFromComment(body: string): string[] | null {
  const match = body.match(/^Test plan:\n((?:[-*] .+(?:\n|$))+)/m);
  if (!match || !match[1]) return null;
  const items = match[1]
    .split("\n")
    .map((l) => l.replace(/^[-*]\s*/, "").trim())
    .filter(Boolean);
  return items.length > 0 ? items : null;
}
