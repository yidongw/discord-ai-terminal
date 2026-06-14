import { describe, expect, it } from "vitest";
import { cursorAgent } from "../../src/agents/cs.js";

describe("cursorAgent.titleCommand", () => {
  it("uses read-only ask mode so title generation cannot run tools or return images", () => {
    expect(cursorAgent.titleCommand("title me")).toContain("--mode ask");
    expect(cursorAgent.titleCommand("title me")).not.toContain("--yolo");
  });
});
