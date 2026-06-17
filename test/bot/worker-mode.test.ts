import { describe, expect, it, vi } from "vitest";
import { AttachmentBuilder, EmbedBuilder } from "discord.js";

vi.mock("bun:sqlite", () => ({
  Database: vi.fn().mockImplementation(() => ({
    exec: vi.fn(),
    prepare: vi.fn(() => ({ get: vi.fn(), run: vi.fn(), all: vi.fn() })),
    close: vi.fn(),
  })),
}));

import { serializeRestMessagePayload } from "../../src/bot/worker-mode.js";

describe("worker-mode REST payload serialization", () => {
  it("serializes AttachmentBuilder files as multipart REST files", () => {
    const attachment = new AttachmentBuilder(Buffer.from([1, 2, 3]), { name: "image.png" });
    const payload = serializeRestMessagePayload({
      content: "here",
      embeds: [new EmbedBuilder().setDescription("image")],
      files: [attachment],
    });

    expect(payload.body.content).toBe("here");
    expect(payload.body.embeds[0].description).toBe("image");
    expect(payload.body.files).toBeUndefined();
    expect(payload.files).toEqual([
      {
        data: Buffer.from([1, 2, 3]),
        name: "image.png",
      },
    ]);
  });
});
