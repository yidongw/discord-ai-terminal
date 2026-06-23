import { describe, it, expect, vi } from "vitest";
import {
  STATUS_EMOJI,
  stripStatusEmoji,
  applyStatusEmoji,
  setThreadStatus,
  isClosedThreadName,
} from "../../src/utils/thread-status.js";

describe("isClosedThreadName", () => {
  it("is true only when the name carries the closed (🗑️) emoji", () => {
    expect(isClosedThreadName(`${STATUS_EMOJI.closed} #121 • foo`)).toBe(true);
    expect(isClosedThreadName(`${STATUS_EMOJI.working} cc • foo`)).toBe(false);
    expect(isClosedThreadName(`${STATUS_EMOJI.locked} cc • foo`)).toBe(false);
    expect(isClosedThreadName("cc • foo")).toBe(false);
  });

  it("is false for empty/missing names", () => {
    expect(isClosedThreadName("")).toBe(false);
    expect(isClosedThreadName(null)).toBe(false);
    expect(isClosedThreadName(undefined)).toBe(false);
  });
});

describe("stripStatusEmoji", () => {
  it("returns the name unchanged when there is no status emoji", () => {
    expect(stripStatusEmoji("cc • fix the bug")).toBe("cc • fix the bug");
  });

  it("removes a leading status emoji and following space", () => {
    expect(stripStatusEmoji(`${STATUS_EMOJI.working} cc • fix the bug`)).toBe("cc • fix the bug");
    expect(stripStatusEmoji(`${STATUS_EMOJI.locked} cc • fix the bug`)).toBe("cc • fix the bug");
    expect(stripStatusEmoji(`${STATUS_EMOJI.closed} cc • fix the bug`)).toBe("cc • fix the bug");
  });
});

describe("applyStatusEmoji", () => {
  it("prefixes a clean name", () => {
    expect(applyStatusEmoji("cc • fix the bug", "working")).toBe(`${STATUS_EMOJI.working} cc • fix the bug`);
  });

  it("replaces an existing status emoji rather than stacking them", () => {
    const working = applyStatusEmoji("cc • fix the bug", "working");
    const locked = applyStatusEmoji(working, "locked");
    expect(locked).toBe(`${STATUS_EMOJI.locked} cc • fix the bug`);
    // No leftover working emoji.
    expect(locked).not.toContain(STATUS_EMOJI.working);
  });

  it("keeps the result within Discord's 100-char limit", () => {
    const long = "x".repeat(120);
    const out = applyStatusEmoji(long, "working");
    expect(out.length).toBeLessThanOrEqual(100);
    expect(out.startsWith(`${STATUS_EMOJI.working} `)).toBe(true);
  });
});

describe("setThreadStatus", () => {
  it("renames the thread when the emoji changes", async () => {
    const thread = { name: "cc • fix the bug", setName: vi.fn().mockResolvedValue(undefined) };
    await setThreadStatus(thread, "working");
    expect(thread.setName).toHaveBeenCalledWith(`${STATUS_EMOJI.working} cc • fix the bug`);
  });

  it("is a no-op when the status is already applied", async () => {
    const thread = {
      name: `${STATUS_EMOJI.working} cc • fix the bug`,
      setName: vi.fn().mockResolvedValue(undefined),
    };
    await setThreadStatus(thread, "working");
    expect(thread.setName).not.toHaveBeenCalled();
  });

  it("uses edit() with extra fields (e.g. archived) so a rename keeps the thread closed", async () => {
    const thread = {
      name: "cc • fix the bug",
      setName: vi.fn().mockResolvedValue(undefined),
      edit: vi.fn().mockResolvedValue(undefined),
    };
    await setThreadStatus(thread, "closed", { archived: true });
    expect(thread.edit).toHaveBeenCalledWith({
      name: `${STATUS_EMOJI.closed} cc • fix the bug`,
      archived: true,
    });
    expect(thread.setName).not.toHaveBeenCalled();
  });

  it("reopens, renames, then re-archives a closed thread (Discord rejects renaming archived threads)", async () => {
    const edits: any[] = [];
    const thread = {
      id: "123",
      name: "cc • fix the bug",
      archived: true,
      setName: vi.fn().mockResolvedValue(undefined),
      edit: vi.fn().mockImplementation((opts: any) => {
        edits.push(opts);
        return Promise.resolve(undefined);
      }),
    };
    await setThreadStatus(thread, "closed", { archived: true });
    // First reopen so Discord will accept the edit...
    expect(edits[0]).toEqual({ archived: false });
    // ...then rename and restore the archived state in one call.
    expect(edits[1]).toEqual({
      name: `${STATUS_EMOJI.closed} cc • fix the bug`,
      archived: true,
    });
    expect(thread.setName).not.toHaveBeenCalled();
  });

  it("never throws when the Discord call rejects", async () => {
    const thread = {
      name: "cc • fix the bug",
      setName: vi.fn().mockRejectedValue(new Error("rate limited")),
    };
    await expect(setThreadStatus(thread, "working")).resolves.toBeUndefined();
  });

  it("ignores objects that cannot be renamed", async () => {
    await expect(setThreadStatus(null, "working")).resolves.toBeUndefined();
    await expect(setThreadStatus({}, "working")).resolves.toBeUndefined();
  });
});
