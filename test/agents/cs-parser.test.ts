import { describe, expect, it } from "vitest";
import { parseCsLine } from "../../src/agents/cs-parser.js";

describe("parseCsLine", () => {
  it("maps generateImageToolCall completion to image_file", () => {
    const event = parseCsLine(
      JSON.stringify({
        type: "tool_call",
        subtype: "completed",
        call_id: "tool_1",
        tool_call: {
          generateImageToolCall: {
            result: {
              success: {
                filePath: "/tmp/discord-pic.png",
              },
            },
          },
        },
      }),
      "/work"
    );

    expect(event).toEqual({ kind: "image_file", filePath: "/tmp/discord-pic.png" });
  });

  it("maps readToolCall on an image to image_file", () => {
    const event = parseCsLine(
      JSON.stringify({
        type: "tool_call",
        subtype: "completed",
        call_id: "tool_2",
        tool_call: {
          readToolCall: {
            args: { path: "/tmp/photo.webp" },
          },
        },
      }),
      "/work"
    );

    expect(event).toEqual({ kind: "image_file", filePath: "/tmp/photo.webp" });
  });

  it("ignores readToolCall on non-image files", () => {
    const event = parseCsLine(
      JSON.stringify({
        type: "tool_call",
        subtype: "completed",
        call_id: "tool_3",
        tool_call: {
          readToolCall: {
            args: { path: "/tmp/readme.txt" },
          },
        },
      }),
      "/work"
    );

    expect(event).toBeNull();
  });
});
