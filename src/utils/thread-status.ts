// Reflects a thread's lifecycle in its NAME via a leading status emoji, so the
// state is visible at a glance in Discord's thread list without opening it.
//
//   working → the agent is actively working in this thread (an in-progress thread)
//   locked  → done for now; worktree + branch deliberately KEPT (not cleaned up)
//   closed  → done for good; worktree + branch have been cleaned up
//
// There are deliberately only three states. Discord rate-limits thread renames
// fairly aggressively (~2 per 10 minutes per thread), so we keep renames sparse:
// "working" is set once when a run starts and left in place — it is NOT cleared
// when a turn finishes — and only changes when the thread is locked or closed.
// That keeps a normal turn at zero/one renames instead of one per message.
//
// Only the emoji prefix is managed — the rest of the name (e.g. "cc • fix bug")
// is preserved. Renames are best-effort and never throw, so they can be
// fire-and-forgotten from hot paths; if rate-limited, discord.js queues them.

export type ThreadStatus = "working" | "locked" | "closed";

export const STATUS_EMOJI: Record<ThreadStatus, string> = {
  working: "🔄",
  locked: "🔒",
  closed: "🗑️",
};

const ALL_EMOJI = Object.values(STATUS_EMOJI);
const THREAD_NAME_LIMIT = 100;

/** Remove any leading status emoji (and the space after it) from a thread name. */
export function stripStatusEmoji(name: string): string {
  for (const e of ALL_EMOJI) {
    if (name.startsWith(e)) return name.slice(e.length).replace(/^\s+/, "");
  }
  return name;
}

/** Produce a thread name with the given status emoji prefixed, within the limit. */
export function applyStatusEmoji(name: string, status: ThreadStatus): string {
  const base = stripStatusEmoji(name);
  const prefix = `${STATUS_EMOJI[status]} `;
  const max = THREAD_NAME_LIMIT - prefix.length;
  const trimmed = base.length > max ? base.slice(0, max) : base;
  return `${prefix}${trimmed}`;
}

/**
 * Set a thread's status emoji prefix. Best-effort: never throws (Discord rename
 * failures are logged and swallowed) so it can be fire-and-forgotten from hot
 * paths. `extraEdit` is merged into the underlying edit — used for the "closed"/
 * "locked" states to set the name while keeping the thread archived in a single
 * call, so the rename doesn't accidentally re-open it. No-ops when the emoji is
 * already applied (and there's no extra edit), avoiding a pointless rename.
 */
export async function setThreadStatus(
  thread: any,
  status: ThreadStatus,
  extraEdit?: Record<string, unknown>
): Promise<void> {
  if (!thread || typeof thread.setName !== "function") return;
  try {
    const current: string = thread.name ?? "";
    const next = applyStatusEmoji(current, status);
    if (next === current && !extraEdit) return;
    if (extraEdit && typeof thread.edit === "function") {
      await thread.edit({ name: next, ...extraEdit });
    } else {
      await thread.setName(next);
    }
  } catch (err) {
    console.error(`[thread-status] failed to set "${status}":`, err);
  }
}
