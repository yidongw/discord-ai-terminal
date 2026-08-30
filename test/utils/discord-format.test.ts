import { describe, it, expect } from "vitest";
import { EmbedBuilder } from "discord.js";
import {
  MAX_EMBED_DESCRIPTION,
  MAX_EMBED_TITLE,
  truncateForEmbed,
} from "../../src/utils/discord-format.js";

describe("truncateForEmbed", () => {
  it("passes through text within the limit", () => {
    expect(truncateForEmbed("hello", MAX_EMBED_DESCRIPTION)).toBe("hello");
  });

  it("truncates long text with an ellipsis", () => {
    const long = "x".repeat(MAX_EMBED_DESCRIPTION + 500);
    const truncated = truncateForEmbed(long, MAX_EMBED_DESCRIPTION);
    expect(truncated.length).toBe(MAX_EMBED_DESCRIPTION);
    expect(truncated.endsWith("…")).toBe(true);
  });

  it("allows EmbedBuilder to accept truncated Codex-style error output", () => {
    const longError =
      "Error running remote compact task: unexpected status 404 Not Found\n" +
      "x".repeat(8000);
    const embed = new EmbedBuilder()
      .setTitle(truncateForEmbed("❌ Failed", MAX_EMBED_TITLE))
      .setDescription(truncateForEmbed(longError, MAX_EMBED_DESCRIPTION))
      .setColor(0xff0000);
    expect(embed.data.description!.length).toBeLessThanOrEqual(MAX_EMBED_DESCRIPTION);
  });
});
