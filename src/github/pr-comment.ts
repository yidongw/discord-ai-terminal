const GITHUB_API = "https://api.github.com";

export async function postPrComment(repo: string, prNumber: number, body: string): Promise<void> {
  const token = process.env.GITHUB_TOKEN;
  if (!token) {
    console.error("[github] GITHUB_TOKEN not set, skipping PR comment");
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
  const token = process.env.GITHUB_TOKEN;
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
