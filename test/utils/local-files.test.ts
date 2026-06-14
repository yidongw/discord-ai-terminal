import { describe, expect, it } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { listLocalFiles } from "../../src/utils/local-files.js";

describe("listLocalFiles", () => {
  it("lists a directory with image metadata", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "local-files-"));
    const sub = path.join(root, "sub");
    const img = path.join(root, "photo.png");
    const txt = path.join(root, "note.txt");
    fs.mkdirSync(sub);
    fs.writeFileSync(img, "img");
    fs.writeFileSync(txt, "txt");

    const result = listLocalFiles(root);
    expect(result.root).toBe(path.resolve(root));
    expect(result.truncated).toBe(false);
    expect(result.entries.map((e) => e.name)).toEqual(["sub", "note.txt", "photo.png"]);
    expect(result.entries.find((e) => e.name === "photo.png")?.isImage).toBe(true);
    expect(result.entries.find((e) => e.name === "sub")?.kind).toBe("directory");
  });

  it("can recurse and truncate", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "local-files-"));
    const nested = path.join(root, "nested");
    fs.mkdirSync(nested);
    fs.writeFileSync(path.join(nested, "a.png"), "a");
    fs.writeFileSync(path.join(nested, "b.png"), "b");

    const result = listLocalFiles(root, { recursive: true, maxEntries: 1 });
    expect(result.truncated).toBe(true);
    expect(result.entries.length).toBe(1);
  });
});
