import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';

const ATTACHMENT_DIR = path.join(os.tmpdir(), 'claude-discord-attachments');
const RETENTION_MS = 60 * 60 * 1000; // 1 hour

export interface DownloadedAttachment {
  tempPath: string;
  originalName: string;
  contentType?: string;
  isImage: boolean;
}

export interface LocalImageReference {
  label: string;
  filePath: string;
}

/**
 * Ensure the temp attachment directory exists
 */
export function ensureAttachmentDir(): void {
  if (!fs.existsSync(ATTACHMENT_DIR)) {
    fs.mkdirSync(ATTACHMENT_DIR, { recursive: true });
  }
}

/**
 * Generate a temp file path for an attachment
 */
export function getTempPath(channelId: string, name: string, index: number): string {
  const timestamp = Date.now();
  const sanitized = name.replace(/[^a-zA-Z0-9.-]/g, '_');
  return path.join(ATTACHMENT_DIR, `${timestamp}-${channelId}-${index}-${sanitized}`);
}

/**
 * Download an attachment from Discord CDN to local temp file
 */
export async function downloadAttachment(url: string, targetPath: string): Promise<void> {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Download failed: ${response.status}`);
  }
  await Bun.write(targetPath, await response.arrayBuffer());
}

/**
 * Check if the content type or filename indicates an image
 */
export function isImageType(contentType?: string, filename?: string): boolean {
  if (contentType?.startsWith('image/')) return true;
  if (filename && /\.(jpg|jpeg|png|gif|webp|bmp)$/i.test(filename)) return true;
  return false;
}

/**
 * Find Markdown links that point at local image files, so they can be uploaded
 * as Discord attachments instead of being shown as plain file links.
 */
export function extractLocalImageReferences(text: string): LocalImageReference[] {
  const refs: LocalImageReference[] = [];
  const linkPattern = /!?\[([^\]]+)\]\(([^)]+)\)/g;
  let match: RegExpExecArray | null;

  while ((match = linkPattern.exec(text)) !== null) {
    const label = match[1]?.trim();
    const filePath = normalizeLocalImagePath(match[2]?.trim());
    if (!label || !filePath) continue;
    refs.push({ label, filePath });
  }

  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    const filePath = normalizeLocalImagePath(trimmed);
    if (!filePath) continue;
    refs.push({ label: path.basename(filePath), filePath });
  }

  return refs;
}

/**
 * Remove local image Markdown links from text after they have been uploaded as
 * attachments. Leaves any surrounding prose intact.
 */
export function stripLocalImageReferences(text: string): string {
  return text
    .split("\n")
    .map((line) => {
      const trimmed = line.trim();
      if (normalizeLocalImagePath(trimmed)) {
        return "";
      }

      if (/^!?\[[^\]]+\]\([^)]+\)$/.test(trimmed)) {
        const match = trimmed.match(/^(!?)\[([^\]]+)\]\(([^)]+)\)$/);
        const filePath = normalizeLocalImagePath(match?.[3]?.trim());
        if (filePath) {
          return "";
        }
      }

      return line.replace(/(!?)\[([^\]]+)\]\(([^)]+)\)/g, (full, bang, label, filePath) => {
        if (!normalizeLocalImagePath(String(filePath))) {
          return full;
        }
        if (bang === "!") return "";
        return String(label).trim();
      });
    })
    .join("\n");
}

function normalizeLocalImagePath(rawPath?: string): string | undefined {
  if (!rawPath) return undefined;
  let filePath = rawPath;
  try {
    filePath = decodeURI(filePath);
  } catch {}
  if (!path.isAbsolute(filePath)) return undefined;
  if (!isImageType(undefined, filePath)) return undefined;
  return filePath;
}

/** Read tool input uses `file_path` (CC) or `path` (Cursor). */
export function getToolInputPath(input: unknown): string | undefined {
  if (!input || typeof input !== "object") return undefined;
  const record = input as Record<string, unknown>;
  const p = record.file_path ?? record.path;
  return p != null ? String(p) : undefined;
}

/** Parse the absolute path from a GenerateImage tool result. */
export function extractGeneratedImagePath(content: unknown): string | undefined {
  const text = toolResultText(content);
  const match = text.match(/Successfully generated image at:\s*(.+)/);
  return match?.[1]?.trim();
}

function toolResultText(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((block) => (typeof block === "object" && block && "text" in block ? String((block as { text: unknown }).text) : ""))
      .join("");
  }
  if (content && typeof content === "object" && "text" in content) {
    return String((content as { text: unknown }).text);
  }
  return "";
}

/**
 * Build an enhanced prompt with attachment references appended
 */
export function buildPromptWithAttachments(
  text: string,
  attachments: DownloadedAttachment[]
): string {
  if (attachments.length === 0) return text;

  const refs = attachments.map((att, i) => {
    const type = att.isImage ? 'Image' : 'File';
    return `- ${type} ${i + 1}: "${att.originalName}" at ${att.tempPath}`;
  }).join('\n');

  return `${text}\n\n---\nAttached files (downloaded to local paths for you to read):\n${refs}`;
}

/**
 * Clean up old attachment files (older than 1 hour)
 */
export function cleanupOldAttachments(): void {
  try {
    if (!fs.existsSync(ATTACHMENT_DIR)) return;

    const now = Date.now();
    const files = fs.readdirSync(ATTACHMENT_DIR);

    for (const file of files) {
      const filePath = path.join(ATTACHMENT_DIR, file);
      const stats = fs.statSync(filePath);
      if (now - stats.mtime.getTime() > RETENTION_MS) {
        fs.unlinkSync(filePath);
        console.log(`Cleaned up old attachment: ${file}`);
      }
    }
  } catch (error) {
    console.error('Error cleaning up attachments:', error);
  }
}

/**
 * Clean up specific attachment files
 */
export function cleanupAttachments(paths: string[]): void {
  for (const p of paths) {
    try {
      if (fs.existsSync(p)) fs.unlinkSync(p);
    } catch (error) {
      console.error(`Error cleaning up ${p}:`, error);
    }
  }
}
