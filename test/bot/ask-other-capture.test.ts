import { describe, it, expect } from "vitest";
import { AskOtherCapture } from "../../src/bot/ask-other-capture.js";

describe("AskOtherCapture", () => {
  it("skips only the capturing user in that channel", () => {
    const cap = new AskOtherCapture();
    cap.begin("thread-1", "user-a");
    expect(cap.shouldSkip("thread-1", "user-a")).toBe(true);
    expect(cap.shouldSkip("thread-1", "user-b")).toBe(false);
    expect(cap.shouldSkip("thread-2", "user-a")).toBe(false);
  });

  it("stops skipping after end", () => {
    const cap = new AskOtherCapture();
    cap.begin("thread-1", "user-a");
    cap.end("thread-1", "user-a");
    expect(cap.shouldSkip("thread-1", "user-a")).toBe(false);
  });

  it("end is a no-op for a different user", () => {
    const cap = new AskOtherCapture();
    cap.begin("thread-1", "user-a");
    cap.end("thread-1", "user-b");
    expect(cap.shouldSkip("thread-1", "user-a")).toBe(true);
  });
});
