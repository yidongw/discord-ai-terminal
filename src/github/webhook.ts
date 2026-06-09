import type { GitHubHandler } from "./handler.js";

const PREVIEW_URL_RE = /https?:\/\/[^\s]+/;

export class GitHubWebhookServer {
  private server?: ReturnType<typeof Bun.serve>;

  constructor(private handler: GitHubHandler) {}

  start(port: number): void {
    const handler = this.handler;

    this.server = Bun.serve({
      port,
      async fetch(req) {
        if (req.method !== "POST") return new Response("Method Not Allowed", { status: 405 });

        const event = req.headers.get("x-github-event");
        const sig = req.headers.get("x-hub-signature-256") ?? "";
        const body = await req.text();

        if (!await verifySignature(body, sig)) {
          console.warn("[webhook] Invalid signature");
          return new Response("Unauthorized", { status: 401 });
        }

        let payload: any;
        try {
          payload = JSON.parse(body);
        } catch {
          return new Response("Bad Request", { status: 400 });
        }

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

async function dispatch(handler: GitHubHandler, event: string, payload: any): Promise<void> {
  const repo: string = payload.repository?.full_name;
  if (!repo) return;

  if (event === "pull_request" && payload.action === "opened") {
    const prNumber: number = payload.pull_request?.number;
    if (prNumber) await handler.handlePrOpened(repo, prNumber);
    return;
  }

  if (event === "issue_comment" && payload.action === "created") {
    // Ignore bot comments to prevent loops
    if (payload.comment?.user?.type === "Bot") return;

    const prNumber: number = payload.issue?.number;
    if (!payload.issue?.pull_request || !prNumber) return;

    const body: string = (payload.comment?.body ?? "").trim();

    const previewUrlFromComment = extractPreviewUrl(payload);

    if (body === "/skip-tests") {
      await handler.handleSkipTests(repo, prNumber);
      return;
    }

    if (body === "/enable-tests") {
      await handler.handleEnableTests(repo, prNumber);
      return;
    }

    // /cc fix:\n- bug1\n- bug2
    const fixMatch = /^\/cc fix:\n([\s\S]+)/.exec(body);
    if (fixMatch) {
      const fixItems = parseItems(fixMatch[1]!);
      if (fixItems.length > 0) {
        await handler.handleComment(repo, prNumber, "", "cc", fixItems);
        return;
      }
    }

    // /cc test:\n- item1\n- item2  or  /cx test:\n...
    const testMatch = /^\/(cc|cx)\s+test:\n([\s\S]+)/.exec(body);
    if (testMatch) {
      const agentKey = testMatch[1]!;
      const testItems = parseItems(testMatch[2]!);
      if (testItems.length > 0) {
        const previewUrl = previewUrlFromComment ?? buildPreviewUrl(repo, prNumber);
        await handler.handleComment(repo, prNumber, previewUrl, agentKey, undefined, testItems);
        return;
      }
    }
  }
}

function parseItems(text: string): string[] {
  return text
    .split("\n")
    .map((l) => l.replace(/^[-*]\s*/, "").trim())
    .filter(Boolean);
}

// Derive the preview URL from the known pattern for this repo.
// Repos can override via PREVIEW_URL_PATTERN=https://erp-pr-{n}.example.com
function buildPreviewUrl(repo: string, prNumber: number): string {
  const pattern = process.env.PREVIEW_URL_PATTERN;
  if (pattern) return pattern.replace("{n}", String(prNumber));
  // Default carbon pattern
  return `https://erp-pr-${prNumber}.foxhole.bot`;
}

// Try to extract a preview URL from recent PR comments via the GitHub API
function extractPreviewUrl(_payload: any): string | null {
  // The preview URL comment is posted by the preview.yml workflow
  // For now we rely on buildPreviewUrl; a future enhancement could
  // fetch comment history to support arbitrary URL patterns
  return null;
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
