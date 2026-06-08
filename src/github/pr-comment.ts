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

export async function getPr(repo: string, prNumber: number): Promise<{ title: string; body: string; head: { ref: string } } | null> {
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
