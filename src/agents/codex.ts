import type { AgentRunner, AgentRunOptions, AgentEvent, AgentParseContext } from "./index.js";
import { buildCodexCommand, escapeShellString } from "../utils/shell.js";
import { DEFAULT_CODEX_MODEL } from "../utils/models.js";
import * as os from "os";
import * as path from "path";

export const codexAgent: AgentRunner = {
  key: "cx",
  label: "Codex",
  color: 0x4B88FF,

  buildCommand(workDir, prompt, opts) {
    return buildCodexCommand(workDir, prompt, opts.sessionId, false, opts.codexModel ?? DEFAULT_CODEX_MODEL);
  },

  parseLine(line, workDir, ctx?: AgentParseContext): AgentEvent | null {
    let msg: any;
    try { msg = JSON.parse(line); } catch { return null; }

    if (msg.type === "thread.started") {
      return {
        kind: "init",
        sessionId: msg.thread_id,
        model: msg.model ?? ctx?.requestedModel ?? DEFAULT_CODEX_MODEL,
        cwd: workDir,
      };
    }

    if (msg.type === "image_generation_end" && msg.call_id && ctx?.sessionId) {
      return {
        kind: "image_file",
        filePath: generatedImagePath(ctx.sessionId, String(msg.call_id)),
      };
    }

    if (msg.type === "item.started" && msg.item?.type === "command_execution") {
      const cmd = String(msg.item.command ?? "").replace(workDir + "/", "./").slice(0, 400);
      // Treat codex's shell command as "Bash" so /tools visibility (and the
      // default-hidden list) applies to it the same way it does for cc.
      return { kind: "tool_start", id: msg.item.id, name: "Bash", label: `🔧 **Command**\n\`\`\`bash\n${cmd}\n\`\`\`` };
    }

    if (msg.type === "item.completed") {
      const item = msg.item;

      if (item?.type === "agent_message" && item.text) {
        return { kind: "text", content: String(item.text) };
      }

      if (item?.type === "command_execution") {
        const out = String(item.aggregated_output ?? "").split("\n")[0]?.slice(0, 120) ?? "";
        const isError = item.status === "failed" || (typeof item.exit_code === "number" && item.exit_code !== 0);
        return { kind: "tool_done", id: item.id, preview: out, isError };
      }

      if (item?.type === "reasoning" && item.text) {
        const short = String(item.text).trim().slice(0, 350);
        return { kind: "text", content: `*🧠 ${short}*` };
      }

      if (item?.type === "file_change") {
        const changes: any[] = Array.isArray(item.changes) ? item.changes.slice(0, 6) : [];
        if (!changes.length) return null;
        const lines = changes.map((c: any) => `• ${c.kind ?? "edit"}: \`${String(c.path ?? "").replace(workDir + "/", "./")}\``);
        return { kind: "text", content: `📝 **File changes**\n${lines.join("\n")}` };
      }

      if (item?.type === "image_generation" && item.call_id && ctx?.sessionId) {
        return {
          kind: "image_file",
          filePath: generatedImagePath(ctx.sessionId, String(item.call_id)),
        };
      }
    }

    if (msg.type === "turn.completed") {
      const u = msg.usage ?? {};
      const tok = [
        u.input_tokens != null ? `↑${u.input_tokens}` : null,
        u.output_tokens != null ? `↓${u.output_tokens}` : null,
        u.cached_input_tokens ? `cache ${u.cached_input_tokens}` : null,
      ].filter(Boolean).join(" ") || null;
      return { kind: "done", turns: null, cost: null, tokens: tok };
    }

    return null;
  },

  titleCommand(prompt) {
    // Omit --json so codex outputs plain text instead of streaming JSON.
    return `codex exec --dangerously-bypass-approvals-and-sandbox ${escapeShellString(prompt)}`;
  },
};

function generatedImagePath(sessionId: string, callId: string): string {
  const codexHome = process.env.CODEX_HOME ?? path.join(os.homedir(), ".codex");
  return path.join(codexHome, "generated_images", sessionId, `${callId}.png`);
}
