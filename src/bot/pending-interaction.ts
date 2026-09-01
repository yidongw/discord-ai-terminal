import { buildPromptWithAttachments, type DownloadedAttachment } from "../utils/attachments.js";
import type { DiscordContext } from "../utils/shell.js";

export interface PendingInteractionRecord {
  prompt: string;
  originalText: string;
  discordContext: DiscordContext;
  agentKey: string;
  workDir: string;
  channelId: string;
  thread: any;
}

export interface PendingInteractionSession {
  agent: string;
  workDir: string;
  channelId: string;
}

export interface PendingInteractionDeps {
  msgId: string;
  thread: any;
  session?: PendingInteractionSession | null;
  existing?: PendingInteractionRecord;
  downloadMsgAttachments: (msg: any) => Promise<DownloadedAttachment[]>;
  fetchReplyContext: (msg: any) => Promise<{ text: string; attachments: DownloadedAttachment[] }>;
}

/**
 * Resolve a queued-message context for button clicks.
 *
 * The in-memory map is the fast path, but if the bot restarted or reconnected
 * after rendering the buttons we can rebuild the context from the original user
 * message still stored in Discord.
 */
export async function resolvePendingInteractionContext(
  deps: PendingInteractionDeps
): Promise<PendingInteractionRecord | null> {
  if (deps.existing) return deps.existing;
  if (!deps.session) return null;
  const fetched = deps.thread?.messages?.fetch;
  if (typeof fetched !== "function") return null;

  let msg: any;
  try {
    msg = await fetched.call(deps.thread.messages, deps.msgId);
  } catch {
    return null;
  }
  if (!msg) return null;

  const attachments = await deps.downloadMsgAttachments(msg);
  const replyContext = await deps.fetchReplyContext(msg);
  const originalText = typeof msg.content === "string" ? msg.content : "";
  const prompt = buildPromptWithAttachments(
    replyContext.text + originalText,
    [...replyContext.attachments, ...attachments]
  );

  return {
    prompt,
    originalText,
    discordContext: {
      channelId: deps.thread.id,
      channelName: deps.thread.name,
      userId: msg.author?.id ?? "",
      messageId: msg.id,
    },
    agentKey: deps.session.agent,
    workDir: deps.session.workDir,
    channelId: deps.session.channelId,
    thread: deps.thread,
  };
}
