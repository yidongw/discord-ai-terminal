/** Prompt sent when a run stalls with no tool in flight — resume and keep streaming. */
export const STALL_CONTINUATION_PROMPT =
  "Your run stopped producing output for 5 minutes while no tool was running.\n\n" +
  "Continue exactly where you left off. Post a brief status update, then keep working. " +
  "While work continues, post a short progress update at least once per minute.";

/**
 * Prompt when the agent process exits without a stream-json `result` / Done event.
 * Common after a bot restart: Discord outbox drain times out mid-reply, the log
 * offset already advanced, and re-attach then sees the process die with no Done.
 */
export const INCOMPLETE_CONTINUATION_PROMPT =
  "Your previous run ended without posting Done (often a bot restart mid-reply — " +
  "some Discord output may have been cut off even if you finished in the session).\n\n" +
  "Continue exactly where you left off. Briefly restate any truncated conclusion, " +
  "then finish remaining work. Post short progress updates at least once per minute.";

/** Max automatic stall wakeups per user turn before we stop retrying. */
export const MAX_STALL_WAKEUPS = 2;

/** Max auto-continues after a silent incomplete exit (no Done) per user turn. */
export const MAX_INCOMPLETE_CONTINUES = 1;
