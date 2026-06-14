import { describe, expect, it } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { isImageGenerationRequest, findLatestDownloadImage } from "../../src/utils/image-requests.js";

describe("isImageGenerationRequest", () => {
  it("matches casual image requests", () => {
    expect(isImageGenerationRequest("send me a pic of space")).toBe(true);
    expect(isImageGenerationRequest("please generate an image of a fox")).toBe(true);
    expect(isImageGenerationRequest("give me a pic from download folder")).toBe(true);
  });

  it("does not match ordinary text", () => {
    expect(isImageGenerationRequest("what is the image size limit?")).toBe(false);
    expect(isImageGenerationRequest("please adjust the picture frame in the layout")).toBe(false);
  });
});

describe("findLatestDownloadImage", () => {
  it("returns the newest image file in a downloads folder", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "downloads-"));
    const older = path.join(dir, "older.png");
    const newer = path.join(dir, "newer.jpg");
    const text = path.join(dir, "note.txt");

    fs.writeFileSync(older, "a");
    fs.writeFileSync(text, "not an image");
    fs.writeFileSync(newer, "b");
    const now = Date.now();
    fs.utimesSync(older, now - 10, now - 10);
    fs.utimesSync(newer, now, now);

    expect(findLatestDownloadImage(dir)).toBe(newer);
  });
});
