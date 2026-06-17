import * as crypto from "crypto";
import type { GitHubHandler } from "./handler.js";

// Localhost-only control plane for gh commands issued by worker agents.
//
// Each worker has a gh wrapper on its PATH that calls this server:
//   /preflight – before every gh invocation, so the server can log the
//                command and optionally block it (return {allow:false}).
//   /link-pr   – after a successful `gh pr create`, with the parsed
//                {threadId, repo, prNumber} so the server links the PR to
//                its maker thread immediately, before any webhook fires.
//
// Both paths are reached from in-session gh calls AND from the Stop hook,
// since the wrapper sits on the agent's inherited PATH.
//
// Auth is HMAC-SHA256(secret, threadId) so each thread can only act on its
// own behalf and cannot spoof another thread's identity.
export class GhControlServer {
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
        if (req.method !== "POST") return new Response("Not Found", { status: 404 });

        let body: unknown;
        try {
          body = await req.json();
        } catch {
          return new Response("Bad Request", { status: 400 });
        }
        if (typeof body !== "object" || body === null) {
          return new Response("Bad Request", { status: 400 });
        }

        const { threadId } = body as Record<string, unknown>;
        if (typeof threadId !== "string") {
          return new Response("Bad Request", { status: 400 });
        }

        const auth = req.headers.get("Authorization") ?? "";
        const expected =
          "Bearer " +
          crypto.createHmac("sha256", secret).update(threadId).digest("hex");
        if (auth !== expected) {
          console.warn(`[gh-control] unauthorized request for thread=${threadId}`);
          return new Response("Unauthorized", { status: 401 });
        }

        if (url.pathname === "/preflight") {
          const { cmd, subcmd } = body as Record<string, unknown>;
          const verb = [cmd, subcmd].filter(Boolean).join(" ");
          console.log(`[gh-control] thread=${threadId}: gh ${verb}`);
          // Policy enforcement point. Return {allow:false,reason:"..."} to block.
          return new Response(JSON.stringify({ allow: true }), {
            headers: { "Content-Type": "application/json" },
          });
        }

        if (url.pathname === "/link-pr") {
          const { repo, prNumber } = body as Record<string, unknown>;
          if (typeof repo !== "string" || typeof prNumber !== "number") {
            return new Response("Missing or invalid fields", { status: 400 });
          }
          console.log(
            `[gh-control] thread=${threadId} created PR #${prNumber} in ${repo}`
          );
          handler.handlePrLinkedByThread(threadId, repo, prNumber).catch((err) => {
            console.error("[gh-control] handlePrLinkedByThread error:", err);
          });
          return new Response("OK");
        }

        return new Response("Not Found", { status: 404 });
      },
    });

    console.log(`[gh-control] listening on 127.0.0.1:${port}`);
  }

  stop(): void {
    this.server?.stop();
  }
}
