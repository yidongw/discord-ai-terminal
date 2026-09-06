/** Prompt sent when a run stalls with no tool in flight — resume and keep streaming. */
export const STALL_CONTINUATION_PROMPT =
  "Your run stopped producing output for 5 minutes while no tool was running.\n\n" +
  "Continue exactly where you left off. Post a brief status update, then keep working. " +
  "While work continues, post a short progress update at least once per minute.";

/** Max automatic stall wakeups per user turn before we stop retrying. */
export const MAX_STALL_WAKEUPS = 2;
