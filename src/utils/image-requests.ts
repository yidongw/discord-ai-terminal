import * as fs from "fs";
import * as os from "os";
import * as path from "path";

const IMAGE_REQUEST_RE =
  /(?:\b(?:send|make|create|generate|render)\b.*\b(?:pic|picture|photo|image)\b)|(?:\b(?:img gen|space pic|generate image|generate a pic|send me a pic|send me a picture|send me a photo)\b)/i;

const IMAGE_EXTENSIONS = new Set([".png", ".jpg", ".jpeg", ".webp", ".gif", ".bmp"]);

/**
 * Heuristic for prompts that are clearly asking for an image rather than text.
 * Kept intentionally broad enough to catch casual phrasing like "send me a pic".
 */
export function isImageGenerationRequest(text: string): boolean {
  return IMAGE_REQUEST_RE.test(text);
}

/**
 * Pick the newest image file from a Downloads folder.
 * Defaults to ~/Downloads so the bot can answer "send me a pic from download folder"
 * without asking the model to guess a filename.
 */
export function findLatestDownloadImage(downloadsDir: string = path.join(os.homedir(), "Downloads")): string | undefined {
  try {
    const entries = fs.readdirSync(downloadsDir, { withFileTypes: true });
    let latestPath: string | undefined;
    let latestMtime = -1;
    let latestBirthtime = -1;

    for (const entry of entries) {
      if (!entry.isFile()) continue;
      const ext = path.extname(entry.name).toLowerCase();
      if (!IMAGE_EXTENSIONS.has(ext)) continue;

      const filePath = path.join(downloadsDir, entry.name);
      const stat = fs.statSync(filePath);
      const mtime = stat.mtimeMs;
      const birthtime = stat.birthtimeMs;
      if (mtime > latestMtime || (mtime === latestMtime && birthtime > latestBirthtime)) {
        latestMtime = mtime;
        latestBirthtime = birthtime;
        latestPath = filePath;
      }
    }

    return latestPath;
  } catch {
    return undefined;
  }
}
