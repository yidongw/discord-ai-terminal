import { describe, it, expect } from "bun:test";
import { BackgroundJobManager } from "../../src/bot/background-jobs.js";

describe("wakeThread vs usage-limit wait", () => {
  const db = { getThreadSession: () => ({ agent: "cc", workDir: "/tmp", channelId: "c" }), listBackgroundJobs: () => [] } as any;
  const client = { channels: { fetch: async () => { throw new Error("must not reach Discord"); } } } as any;

  it("refuses (ok:false, usageLimited) while the thread waits for a usage-limit reset", async () => {
    const sm = { getUsageLimitWait: () => ({ waiting: true, resetLabel: "9/25 23:00" }), hasActiveProcess: () => false } as any;
    const mgr = new BackgroundJobManager(client, sm, db);
    const r = await mgr.wakeThread("t1", "go");
    expect(r.ok).toBe(false);
    expect(r.usageLimited).toBe(true);
    expect(r.error).toContain("usage-limit");
  });

  it("proceeds past the usage check when the thread is not limited", async () => {
    const sm = { getUsageLimitWait: () => ({ waiting: false }), hasActiveProcess: () => false } as any;
    const mgr = new BackgroundJobManager(client, sm, db);
    const r = await mgr.wakeThread("t1", "go");
    // reaches the Discord fetch (stubbed to throw) → a fetch error, not a usage refusal
    expect(r.usageLimited).toBeUndefined();
    expect(r.error).toContain("must not reach Discord");
  });
});
