// Smoke test of the MCP HTTP server (the endpoint agents' wake_thread calls fall back to, cx43 :3001).
// Boots MCPPermissionServer on a free local port with a stub background-job manager, then checks
// /health, the wake_thread route (missing thread_id → error, a thread id → reaches wakeThread) and
// that the MCP endpoint answers. No Discord login, no database, no network beyond 127.0.0.1.
//   bun run scripts/ci/smoke-mcp.ts   (exit 0 = ok)
import { createServer } from "node:net";
import { MCPPermissionServer } from "../../src/mcp/server.ts";

const port: number = await new Promise((resolve, reject) => {
  const s = createServer();
  s.once("error", reject);
  s.listen(0, "127.0.0.1", () => {
    const p = (s.address() as { port: number }).port;
    s.close(() => resolve(p));
  });
});

const woken: string[] = [];
const server = new MCPPermissionServer(port);
server.setBackgroundJobManager({
  wakeThread: async (threadId: string) => {
    woken.push(threadId);
    return { ok: true, threadId };
  },
} as never);
await server.start();

const base = `http://127.0.0.1:${port}`;
const fail = (msg: string): never => {
  console.error(`smoke-mcp: FAIL ${msg}`);
  process.exit(1);
};
const post = async (path: string, body: unknown) => {
  const r = await fetch(base + path, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
    body: JSON.stringify(body),
  });
  return { status: r.status, text: await r.text() };
};

try {
  const h = await fetch(`${base}/health`);
  const hj = (await h.json()) as { status?: string };
  if (h.status !== 200 || hj.status !== "ok") fail(`/health → ${h.status} ${JSON.stringify(hj)}`);

  const missing = await post("/tool/wake_thread", {});
  if (!String((JSON.parse(missing.text) as { error?: string }).error ?? "").includes('"thread_id" string is required')) fail(`wake_thread without thread_id → ${missing.text}`);

  const ok = await post("/tool/wake_thread", { thread_id: "123456789012345678", prompt: "smoke", reason: "ci" });
  if (!ok.text.includes('"ok":true') || woken[0] !== "123456789012345678") fail(`wake_thread did not reach the job manager → ${ok.text}`);

  const mcp = await post("/mcp", {
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "smoke", version: "0" } },
  });
  if (mcp.status !== 200 || !mcp.text.includes('"serverInfo"')) fail(`/mcp initialize → ${mcp.status} ${mcp.text.slice(0, 200)}`);

  console.log("smoke-mcp: ok (/health, /tool/wake_thread, /mcp initialize)");
} finally {
  await server.stop();
}
process.exit(0);
