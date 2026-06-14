import { describe, expect, it } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import {
  findLatestDownloadImage,
  parseDownloadImageDecision,
} from "../../src/utils/image-requests.js";

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

describe("parseDownloadImageDecision", () => {
  it("recognizes the classifier tokens", () => {
    expect(parseDownloadImageDecision("DOWNLOAD_IMAGE")).toBe(true);
    expect(parseDownloadImageDecision("OTHER")).toBe(false);
    expect(parseDownloadImageDecision("DOWNLOAD_IMAGE\n")).toBe(true);
  });
});
