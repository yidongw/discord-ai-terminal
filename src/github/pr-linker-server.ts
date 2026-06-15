import * as crypto from "crypto";
import type { GitHubHandler } from "./handler.js";

// Lightweight localhost-only HTTP server that agent gh wrappers call after
// `gh pr create` to link the new PR to the thread that created it.
//
// Runs separately from the public GitHub webhook server so it is never exposed
// to the internet. Auth is HMAC-SHA256(secret, threadId) so each thread can
// only link PRs on its own behalf.
export class PrLinkerServer {
  private server?: ReturnType<typeof Bun.serve>;

  constructor(
    private handler: GitHubHandler,
    private secret: string
  ) {}

  start(port: number): void {
    const { handler, secret } = this;

    this.server = Bun.serve({
      hostname: "127.0.0.1",
      port,
      async fetch(req) {
        const url = new URL(req.url);
        if (req.method !== "POST" || url.pathname !== "/link-pr") {
          return new Response("Not Found", { status: 404 });
        }

        let body: unknown;
        try {
          body = await req.json();
        } catch {
          return new Response("Bad Request", { status: 400 });
        }
        if (typeof body !== "object" || body === null) {
          return new Response("Bad Request", { status: 400 });
        }

        const { threadId, repo, prNumber } = body as Record<string, unknown>;
        if (
          typeof threadId !== "string" ||
          typeof repo !== "string" ||
          typeof prNumber !== "number"
        ) {
          return new Response("Missing or invalid fields", { status: 400 });
        }

        const auth = req.headers.get("Authorization") ?? "";
        const expected =
          "Bearer " +
          crypto.createHmac("sha256", secret).update(threadId).digest("hex");
        if (auth !== expected) {
          console.warn(`[pr-linker] unauthorized request for thread=${threadId}`);
          return new Response("Unauthorized", { status: 401 });
        }

        console.log(
          `[pr-linker] thread=${threadId} created PR #${prNumber} in ${repo}`
        );
        // Fire-and-forget; the agent doesn't need to wait for Discord updates.
        handler.handlePrLinkedByThread(threadId, repo, prNumber).catch((err) => {
          console.error("[pr-linker] handlePrLinkedByThread error:", err);
        });
        return new Response("OK");
      },
    });

    console.log(`[pr-linker] listening on 127.0.0.1:${port}`);
  }

  stop(): void {
    this.server?.stop();
  }
}
