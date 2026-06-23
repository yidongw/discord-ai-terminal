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

/**
 * Thread IDs we're mid-rename on while restoring the archived state. Renaming a
 * closed thread requires reopen → rename → re-archive (Discord rejects edits to
 * an archived thread), and that re-archive emits its own `threadUpdate` "close".
 * The lifecycle handler consults this set to ignore those self-induced events so
 * it doesn't treat our own edit as a fresh user close.
 */
export const renamingClosedThreads = new Set<string>();

/**
 * True when a thread name already carries the "closed" (🗑️) status emoji, i.e.
 * the thread has already been closed and cleaned up. Used to make close-cleanup
 * idempotent so re-close events don't re-run it.
 */
export function isClosedThreadName(name: string | null | undefined): boolean {
  return !!name && name.startsWith(STATUS_EMOJI.closed);
}

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
 * Return a thread name body (no emoji) with the agent prefix replaced by the
 * PR number. Works whether or not `name` has a leading status emoji.
 *
 *   "🔄 cc • Fix auth bug"  →  "#20 • Fix auth bug"
 *   "cc • Fix auth bug"     →  "#20 • Fix auth bug"
 */
export function threadNameWithPr(name: string, prNumber: number): string {
  const stripped = stripStatusEmoji(name);
  const sep = stripped.indexOf(" • ");
  const title = sep !== -1 ? stripped.slice(sep + 3) : stripped;
  return `#${prNumber} • ${title}`;
}

/**
 * Inject the PR number into a thread's name, replacing the agent prefix while
 * preserving the status emoji. Best-effort: never throws.
 */
export async function setPrInThreadName(thread: any, prNumber: number): Promise<void> {
  if (!thread || typeof thread.setName !== "function") return;
  try {
    const current: string = thread.name ?? "";
    const base = threadNameWithPr(current, prNumber);
    const entry = Object.entries(STATUS_EMOJI).find(([, e]) => current.startsWith(e));
    const status = (entry?.[0] as ThreadStatus) ?? "working";
    const next = applyStatusEmoji(base, status);
    if (next === current) return;
    await thread.setName(next);
  } catch (err) {
    console.error("[thread-status] failed to inject PR number:", err);
  }
}

/**
 * Set a thread's status emoji prefix. Best-effort: never throws (Discord rename
 * failures are logged and swallowed) so it can be fire-and-forgotten from hot
 * paths. No-ops when the emoji is already applied, avoiding a pointless rename.
 *
 * Discord rejects edits to an ARCHIVED thread — even a plain rename — with
 * "Thread is archived" (400). So when the thread is already closed we can't
 * rename it in place: we reopen it, rename, then re-archive. `extraEdit` is
 * merged into the rename (the "closed"/"locked" callers pass `{ archived: true }`),
 * and we always restore the archived state afterwards so the thread stays closed.
 * The re-archive emits its own `threadUpdate`; we register the id in
 * `renamingClosedThreads` so the lifecycle handler ignores that self-induced event.
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
    if (next === current) return; // emoji already applied — nothing to do

    if (thread.archived && typeof thread.edit === "function") {
      // Reopen so Discord accepts the rename, then rename + restore the archived
      // state. The id is consumed by the lifecycle handler when the re-archive
      // event lands; on failure we drop it here so it can't leak.
      if (thread.id) renamingClosedThreads.add(thread.id);
      try {
        await thread.edit({ archived: false });
        await thread.edit({ name: next, ...extraEdit, archived: true });
      } catch (err) {
        if (thread.id) renamingClosedThreads.delete(thread.id);
        throw err;
      }
    } else if (extraEdit && typeof thread.edit === "function") {
      await thread.edit({ name: next, ...extraEdit });
    } else {
      await thread.setName(next);
    }
  } catch (err) {
    console.error(`[thread-status] failed to set "${status}":`, err);
  }
}
