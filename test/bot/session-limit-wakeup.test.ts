import { describe, it, expect } from "vitest";
import type { ScheduledTask } from "../../src/db/database.js";
import {
  SESSION_LIMIT_CONTINUATION_PROMPT,
  buildSessionLimitWakeupTask,
  registerSessionLimitWakeup,
  sessionLimitTaskId,
} from "../../src/bot/session-limit-wakeup.js";
import { parseSessionLimitReset } from "../../src/utils/session-limit-reset.js";

describe("session-limit wakeup", () => {
  it("uses a continue-where-you-left-off prompt", () => {
    expect(SESSION_LIMIT_CONTINUATION_PROMPT).toContain("Continue exactly where you left off");
    expect(SESSION_LIMIT_CONTINUATION_PROMPT).toContain("Do not restart from scratch");
  });

  it("builds a one-shot cc scheduled task at the parsed reset time", () => {
    const now = new Date("2026-06-11T14:00:00");
    const parsed = parseSessionLimitReset(
      "You've hit your session limit · resets 3:45pm",
      now
    )!;

    const task = buildSessionLimitWakeupTask({
      threadId: "thread-abc",
      channelId: "channel-xyz",
      workDir: "/tmp/work",
      userId: "user-1",
      resetAt: parsed.resetAt,
      now: now.getTime(),
    });

    expect(task.id).toBe("session-limit-thread-abc");
    expect(task.agent).toBe("cc");
    expect(task.prompt).toBe(SESSION_LIMIT_CONTINUATION_PROMPT);
    expect(task.label).toBe("Session limit resume");
    expect(task.maxRuns).toBe(1);
    expect(task.enabled).toBe(true);
    expect(task.nextRunAt).toBe(parsed.resetAt);
    expect(new Date(task.nextRunAt).getHours()).toBe(15);
    expect(new Date(task.nextRunAt).getMinutes()).toBe(45);
  });

  it("registers the wakeup in scheduled_tasks and replaces any prior row", () => {
    const tasks = new Map<string, ScheduledTask>();
    const db = {
      getScheduledTask: (id: string) => tasks.get(id) ?? null,
      deleteScheduledTask: (id: string) => { tasks.delete(id); },
      createScheduledTask: (task: ScheduledTask) => { tasks.set(task.id, task); },
    };

    const resetAt = Date.parse("2026-06-11T15:45:00");
    const first = registerSessionLimitWakeup(db, {
      threadId: "thread-abc",
      channelId: "channel-xyz",
      workDir: "/tmp/work",
      userId: "user-1",
      resetAt,
    });

    expect(tasks.size).toBe(1);
    expect(tasks.get(sessionLimitTaskId("thread-abc"))).toEqual(first);

    const laterReset = Date.parse("2026-06-11T16:00:00");
    const second = registerSessionLimitWakeup(db, {
      threadId: "thread-abc",
      channelId: "channel-xyz",
      workDir: "/tmp/work",
      userId: "user-1",
      resetAt: laterReset,
    });

    expect(tasks.size).toBe(1);
    expect(second.nextRunAt).toBe(laterReset);
    expect(tasks.get(sessionLimitTaskId("thread-abc"))?.nextRunAt).toBe(laterReset);
  });
});
