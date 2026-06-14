import * as fs from "fs";
import * as path from "path";
import { isImageType } from "./attachments.js";

export interface LocalFileEntry {
  path: string;
  name: string;
  kind: "file" | "directory";
  size?: number;
  mtimeMs?: number;
  isImage: boolean;
}

export interface ListLocalFilesOptions {
  recursive?: boolean;
  maxEntries?: number;
  includeHidden?: boolean;
}

export interface ListLocalFilesResult {
  root: string;
  entries: LocalFileEntry[];
  truncated: boolean;
}

export function listLocalFiles(rootPath: string, options: ListLocalFilesOptions = {}): ListLocalFilesResult {
  const resolvedRoot = path.resolve(rootPath);
  const stats = fs.statSync(resolvedRoot);
  if (!stats.isDirectory()) {
    throw new Error(`Not a directory: ${resolvedRoot}`);
  }

  const recursive = options.recursive ?? false;
  const maxEntries = options.maxEntries ?? 100;
  const includeHidden = options.includeHidden ?? false;
  const entries: LocalFileEntry[] = [];
  let truncated = false;

  const walk = (dirPath: string): void => {
    if (truncated) return;

    const dirents = fs.readdirSync(dirPath, { withFileTypes: true })
      .filter((entry) => includeHidden || !entry.name.startsWith("."))
      .sort((a, b) => {
        if (a.isDirectory() !== b.isDirectory()) return a.isDirectory() ? -1 : 1;
        return a.name.localeCompare(b.name);
      });

    for (const entry of dirents) {
      if (entries.length >= maxEntries) {
        truncated = true;
        return;
      }

      const fullPath = path.join(dirPath, entry.name);
      const stat = fs.statSync(fullPath);
      entries.push({
        path: fullPath,
        name: entry.name,
        kind: entry.isDirectory() ? "directory" : "file",
        size: entry.isFile() ? stat.size : undefined,
        mtimeMs: stat.mtimeMs,
        isImage: entry.isFile() && isImageType(undefined, entry.name),
      });

      if (recursive && entry.isDirectory()) {
        walk(fullPath);
      }
    }
  };

  walk(resolvedRoot);

  return { root: resolvedRoot, entries, truncated };
}
