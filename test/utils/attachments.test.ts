import { describe, expect, it } from "vitest";
import {
  extractGeneratedImagePath,
  getToolInputPath,
  isImageType,
} from "../../src/utils/attachments.js";

describe("getToolInputPath", () => {
  it("reads file_path from CC-style Read input", () => {
    expect(getToolInputPath({ file_path: "/tmp/a.png" })).toBe("/tmp/a.png");
  });

  it("reads path from Cursor-style Read input", () => {
    expect(getToolInputPath({ path: "/tmp/a.png" })).toBe("/tmp/a.png");
  });
});

describe("extractGeneratedImagePath", () => {
  it("parses the path from a GenerateImage tool result", () => {
    const content =
      "Successfully generated image at: /Users/me/.cursor/projects/foo/assets/pic.png";
    expect(extractGeneratedImagePath(content)).toBe(
      "/Users/me/.cursor/projects/foo/assets/pic.png"
    );
  });
});

describe("isImageType", () => {
  it("detects image extensions", () => {
    expect(isImageType(undefined, "/tmp/photo.webp")).toBe(true);
    expect(isImageType(undefined, "/tmp/readme.txt")).toBe(false);
  });
});
