import type { GitHubHandler } from "./handler.js";

// Ensures a webhook exists for `repo` pointing at `webhookUrl`.
// Looks for an existing webhook whose URL contains `webhookUrl` (idempotent);
// creates one with pull_request + workflow_run events if none found.
// Reads GITHUB_TOKEN and GITHUB_WEBHOOK_SECRET from env.
export async function registerGitHubWebhook(repo: string, webhookUrl: string): Promise<void> {
  const token = process.env.GITHUB_TOKEN ?? "";
  const secret = process.env.GITHUB_WEBHOOK_SECRET ?? "";
  const headers = {
    "Authorization": `Bearer ${token}`,
    "Content-Type": "application/json",
    "Accept": "application/vnd.github+json",
  };

  const listRes = await fetch(`https://api.github.com/repos/${repo}/hooks`, { headers })
    .catch((err) => { console.error(`[webhook] register: list hooks failed for ${repo}:`, err); return null; });
  if (!listRes?.ok) {
    console.error(`[webhook] register: list hooks returned ${listRes?.status} for ${repo}`);
    return;
  }

  const hooks = await listRes.json() as Array<{ id: number; config: { url: string } }>;
  const existing = hooks.find((h) => h.config.url?.includes(new URL(webhookUrl).hostname));

  if (existing) {
    if (existing.config.url === webhookUrl) {
      console.log(`[webhook] register: hook ${existing.id} for ${repo} already up to date`);
      return;
    }
    const res = await fetch(`https://api.github.com/repos/${repo}/hooks/${existing.id}`, {
      method: "PATCH", headers,
      body: JSON.stringify({ config: { url: webhookUrl, content_type: "json", secret } }),
    });
    if (res.ok) console.log(`[webhook] register: updated hook ${existing.id} for ${repo} → ${webhookUrl}`);
    else console.error(`[webhook] register: PATCH failed for ${repo}: ${res.status}`);
  } else {
    const res = await fetch(`https://api.github.com/repos/${repo}/hooks`, {
      method: "POST", headers,
      body: JSON.stringify({
        name: "web", active: true,
        events: ["pull_request", "workflow_run"],
        config: { url: webhookUrl, content_type: "json", secret },
      }),
    });
    if (res.ok) console.log(`[webhook] register: created hook for ${repo} → ${webhookUrl}`);
    else console.error(`[webhook] register: POST failed for ${repo}: ${res.status}`);
  }
}

export class GitHubWebhookServer {
  private server?: ReturnType<typeof Bun.serve>;

  constructor(private handler: GitHubHandler) {}

  start(port: number): void {
    const handler = this.handler;

    this.server = Bun.serve({
      port,
      async fetch(req) {
        const pathname = new URL(req.url).pathname;
        if (req.method !== "POST") return new Response("Method Not Allowed", { status: 405 });

        const body = await req.text();

        if (pathname === "/preview-ready") {
          return handlePreviewReady(handler, req, body);
        }

        const event = req.headers.get("x-github-event");
        const sig = req.headers.get("x-hub-signature-256") ?? "";

        console.log(`[webhook] received event=${event ?? "(none)"} sig=${sig ? "present" : "missing"} path=${pathname}`);

        if (!await verifySignature(body, sig)) {
          console.warn("[webhook] Invalid signature — check GITHUB_WEBHOOK_SECRET matches the secret set on GitHub");
          return new Response("Unauthorized", { status: 401 });
        }

        let payload: any;
        try {
          payload = JSON.parse(body);
        } catch {
          return new Response("Bad Request", { status: 400 });
        }

        console.log(`[webhook] dispatching event=${event} action=${payload?.action ?? "(none)"} repo=${payload?.repository?.full_name ?? "(none)"}`);

        // Handle asynchronously — GitHub expects a fast 200
        setImmediate(() => dispatch(handler, event ?? "", payload).catch(console.error));
        return new Response("OK");
      },
    });

    console.log(`[webhook] GitHub webhook server listening on port ${port}`);
  }

  stop(): void {
    this.server?.stop();
  }
}

async function handlePreviewReady(handler: GitHubHandler, req: Request, body: string): Promise<Response> {
  const secret = process.env.PREVIEW_READY_SECRET;
  if (secret) {
    const auth = req.headers.get("authorization") ?? "";
    if (auth !== `Bearer ${secret}`) {
      return new Response("Unauthorized", { status: 401 });
    }
  }

  let payload: any;
  try {
    payload = JSON.parse(body);
  } catch {
    return new Response("Bad Request", { status: 400 });
  }

  const { repo, prNumber, previewUrl } = payload;
  if (!repo || !prNumber || !previewUrl) {
    return new Response("Missing repo, prNumber, or previewUrl", { status: 400 });
  }

  console.log(`[webhook] /preview-ready: repo=${repo} prNumber=${prNumber} previewUrl=${previewUrl}`);
  await handler.handlePreviewUrl(repo, Number(prNumber), previewUrl);
  return new Response("OK");
}

async function dispatch(handler: GitHubHandler, event: string, payload: any): Promise<void> {
  const repo: string = payload.repository?.full_name;
  if (!repo) return;

  if (event === "pull_request") {
    const prNumber: number = payload.pull_request?.number;
    const headRef: string = payload.pull_request?.head?.ref ?? "";

    if (
      payload.action === "opened" ||
      payload.action === "reopened" ||
      payload.action === "ready_for_review"
    ) {
      if (prNumber) await handler.handlePrOpened(repo, prNumber, headRef);
      return;
    }

    if (payload.action === "synchronize") {
      if (prNumber) {
        const headSha: string = payload.after ?? payload.pull_request?.head?.sha ?? "";
        await handler.handlePrSynchronized(repo, prNumber, headRef, headSha);
      }
      return;
    }

    if (payload.action === "closed") {
      if (prNumber) {
        const merged: boolean = !!payload.pull_request?.merged;
        const mergedBy: string | null = payload.pull_request?.merged_by?.login ?? null;
        const prTitle: string = payload.pull_request?.title ?? "";
        await handler.handlePrClosed(repo, prNumber, merged, mergedBy, prTitle, headRef);
      }
      return;
    }

    return;
  }

  if (
    event === "workflow_run" &&
    payload.action === "completed" &&
    (payload.workflow_run?.conclusion === "failure" ||
      payload.workflow_run?.conclusion === "timed_out")
  ) {
    const run = payload.workflow_run;
    const prNumber: number | null = run.pull_requests?.[0]?.number ?? null;
    const workflowName: string = run.name ?? "Unknown workflow";
    const runUrl: string = run.html_url ?? "";
    const headBranch: string = run.head_branch ?? "";
    await handler.handleCiFailure(repo, prNumber, workflowName, runUrl, headBranch);
    return;
  }
}

async function verifySignature(body: string, sig: string): Promise<boolean> {
  const secret = process.env.GITHUB_WEBHOOK_SECRET;
  if (!secret) {
    console.warn("[webhook] GITHUB_WEBHOOK_SECRET not set — skipping verification");
    return true;
  }
  if (!sig.startsWith("sha256=")) return false;

  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const mac = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(body));
  const expected = "sha256=" + Buffer.from(mac).toString("hex");

  // Constant-time comparison
  if (expected.length !== sig.length) return false;
  let diff = 0;
  for (let i = 0; i < expected.length; i++) {
    diff |= expected.charCodeAt(i) ^ sig.charCodeAt(i);
  }
  return diff === 0;
}
