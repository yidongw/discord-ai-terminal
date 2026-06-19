import { describe, it, expect } from "vitest";
import {
  formatPrMergedMessage,
  formatPrClosedMessage,
  formatPrOpenedMessage,
  formatPrNewCommitsMessage,
} from "../../src/github/pr-notifications.js";

const PR_URL = "https://github.com/yidongw/carbon/pull/83";

describe("pr-notifications", () => {
  it("formats merged PR with title and author", () => {
    expect(
      formatPrMergedMessage(
        83,
        "fix(i18n): translate job BOP operation status labels",
        "yidongw",
        PR_URL
      )
    ).toBe(
      "🔀 Merged PR #83 — fix(i18n): translate job BOP operation status labels by @yidongw.\n" +
        PR_URL
    );
  });

  it("formats merged PR without title or author", () => {
    expect(formatPrMergedMessage(1, "", null, PR_URL)).toBe(
      "🔀 Merged PR #1.\n" + PR_URL
    );
  });

  it("formats closed PR without merging", () => {
    expect(formatPrClosedMessage(42, "WIP experiment", PR_URL)).toBe(
      "🚫 Closed PR #42 — WIP experiment without merging.\n" + PR_URL
    );
  });

  it("formats opened PR", () => {
    expect(formatPrOpenedMessage(7, PR_URL)).toBe(
      "📎 Opened PR #7\n" + PR_URL
    );
  });

  it("formats new commits pushed", () => {
    expect(formatPrNewCommitsMessage(9, " — `abc1234`", PR_URL)).toBe(
      "🔄 New commits pushed to PR #9 — `abc1234`\n" + PR_URL
    );
  });
});
