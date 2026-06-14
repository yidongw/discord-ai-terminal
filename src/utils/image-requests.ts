import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { $ } from "bun";

const IMAGE_EXTENSIONS = new Set([".png", ".jpg", ".jpeg", ".webp", ".gif", ".bmp"]);
const DOWNLOAD_IMAGE_DECISION = "DOWNLOAD_IMAGE";
const OTHER_DECISION = "OTHER";
const IMAGE_REQUEST_CLASSIFIER_PROMPT =
  "You classify Discord messages for a local file action. " +
  "Return exactly one token and nothing else: " +
  "DOWNLOAD_IMAGE if the user is asking for an image/photo/pic/picture to be sent from their local Downloads folder or the latest local image; " +
  "OTHER for everything else. " +
  "If the request is ambiguous, return OTHER.\n\nMessage: ";

/**
 * Parse a classifier response into the internal decision token.
 */
export function parseDownloadImageDecision(output: string): boolean | undefined {
  const token = output.trim().split(/\s+/)[0]?.replace(/[^A-Z_]/g, "");
  if (token === DOWNLOAD_IMAGE_DECISION) return true;
  if (token === OTHER_DECISION) return false;
  return undefined;
}

/**
 * Use a model-backed classifier to decide whether a message should trigger a
 * direct upload of the newest image from Downloads.
 */
export async function shouldSendLatestDownloadImage(text: string): Promise<boolean> {
  try {
    const prompt = IMAGE_REQUEST_CLASSIFIER_PROMPT + text.slice(0, 1000);
    const output = await $`claude -p ${prompt}`.text();
    const decision = parseDownloadImageDecision(output);
    if (decision !== undefined) return decision;
  } catch (err) {
    console.error("Image request classifier failed:", err);
  }
  return false;
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
