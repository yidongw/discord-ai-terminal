import { describe, expect, it } from "vitest";
import {
  extractGeneratedImagePath,
  extractLocalImageReferences,
  getToolInputPath,
  isImageType,
  stripLocalImageReferences,
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

describe("local image references", () => {
  it("extracts absolute markdown links to image files", () => {
    expect(
      extractLocalImageReferences(
        "Here it is:\n\n[Snipaste_2026-05-08_19-49-59.png](/Users/me/Downloads/Snipaste_2026-05-08_19-49-59.png)"
      )
    ).toEqual([
      {
        label: "Snipaste_2026-05-08_19-49-59.png",
        filePath: "/Users/me/Downloads/Snipaste_2026-05-08_19-49-59.png",
      },
    ]);
  });

  it("extracts absolute markdown image links to image files", () => {
    expect(
      extractLocalImageReferences(
        "Here it is:\n\n![Screenshot 2026-04-22 at 2.16.28 AM](/Users/me/Downloads/Screenshot 2026-04-22 at 2.16.28 AM.png)"
      )
    ).toEqual([
      {
        label: "Screenshot 2026-04-22 at 2.16.28 AM",
        filePath: "/Users/me/Downloads/Screenshot 2026-04-22 at 2.16.28 AM.png",
      },
    ]);
  });

  it("decodes URL-encoded absolute markdown image paths", () => {
    expect(
      extractLocalImageReferences(
        "Here it is:\n\n![Screenshot](/Users/me/Downloads/Screenshot%202026-04-22%20at%202.16.28%E2%80%AFAM.png)"
      )
    ).toEqual([
      {
        label: "Screenshot",
        filePath: "/Users/me/Downloads/Screenshot 2026-04-22 at 2.16.28 AM.png",
      },
    ]);
  });

  it("leaves non-image or non-local links alone", () => {
    expect(
      extractLocalImageReferences("[docs](https://example.com/pic.png)")
    ).toEqual([]);
  });

  it("does not strip remote markdown image links", () => {
    expect(stripLocalImageReferences("![remote](https://example.com/pic.png)")).toBe(
      "![remote](https://example.com/pic.png)"
    );
  });

  it("strips local image markdown links down to their labels", () => {
    expect(
      stripLocalImageReferences(
        "Here’s one from Downloads:\n\n[Snipaste.png](/Users/me/Downloads/Snipaste.png)"
      )
    ).toBe("Here’s one from Downloads:\n\n");
  });

  it("strips standalone local markdown image links", () => {
    expect(
      stripLocalImageReferences(
        "Here’s one from Downloads:\n\n![Screenshot](/Users/me/Downloads/Screenshot.png)"
      )
    ).toBe("Here’s one from Downloads:\n\n");
  });

  it("handles a standalone absolute image path", () => {
    expect(
      extractLocalImageReferences(
        "Here it is:\n\n/Users/me/Downloads/Snipaste.png"
      )
    ).toEqual([
      {
        label: "Snipaste.png",
        filePath: "/Users/me/Downloads/Snipaste.png",
      },
    ]);
    expect(
      stripLocalImageReferences(
        "Here it is:\n\n/Users/me/Downloads/Snipaste.png"
      )
    ).toBe("Here it is:\n\n");
  });
});
