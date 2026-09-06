/**
 * Claude Code injects an internal "Continue from where you left off." prompt when a
 * session process exits unexpectedly (e.g. Discord interrupt, or ask_user_question
 * Other... reply racing into a new runAgent / killProcess). The model often replies
 * "No response requested." and the CLI exits with success of 0 turns / $0 — before
 * the real -p user prompt is processed.
 *
 * The same 0-turn success also shows up when Claude ingests a pending
 * task-notification (or other queue noise) and exits without calling the model on
 * the user's -p prompt. Detect that phantom completion so we can re-dispatch.
 *
 * Retry budget: attempt 1 resumes the same session; attempt 2 starts fresh so a
 * wedged resume transcript cannot loop forever.
 */

export const MAX_EMPTY_DONE_RETRIES = 2;

const NO_RESPONSE_ACKS = new Set([
  "no response requested.",
  "no action needed.",
  "nothing needed from you.",
]);

/** True when assistant text is Claude Code's empty-continue acknowledgement. */
export function isNoResponseAck(content: string): boolean {
  return NO_RESPONSE_ACKS.has(content.trim().toLowerCase());
}

export interface EmptyDoneContext {
  agentKey: string;
  turns: number | null;
  sawRealAssistantText: boolean;
  toolCallCount: number;
  prompt: string;
  retriesSoFar: number;
}

/**
 * True when a done event looks like the interrupt/restart phantom continue —
 * no model turns, no real work, and we still have a user prompt to retry.
 */
export function shouldRetryEmptyDone(ctx: EmptyDoneContext): boolean {
  if (ctx.agentKey !== "cc") return false;
  if (ctx.turns !== 0) return false;
  if (ctx.sawRealAssistantText) return false;
  if (ctx.toolCallCount > 0) return false;
  if (!ctx.prompt.trim()) return false;
  if (ctx.retriesSoFar >= MAX_EMPTY_DONE_RETRIES) return false;
  return true;
}

/**
 * After the first same-session retry still returns 0 turns, drop the resume ID
 * so Claude cannot keep short-circuiting on a wedged transcript.
 * `retryAttempt` is 1-based (the value stored in emptyDoneRetryCount after arming).
 */
export function shouldFreshSessionEmptyDone(retryAttempt: number): boolean {
  return retryAttempt >= 2;
}
