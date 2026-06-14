import * as fs from "fs";
import * as os from "os";
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

export interface FindLocalPathsOptions {
  roots?: string[];
  recursive?: boolean;
  maxEntries?: number;
  maxDepth?: number;
  includeHidden?: boolean;
  directoriesOnly?: boolean;
}

export interface LocalPathMatch extends LocalFileEntry {
  score: number;
}

export interface FindLocalPathsResult {
  query: string;
  roots: string[];
  entries: LocalPathMatch[];
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

function defaultSearchRoots(): string[] {
  const home = process.env.HOME ? path.resolve(process.env.HOME) : os.homedir();
  return [
    path.join(home, "git"),
    path.join(home, "git", "worktrees"),
    path.join(home, "Downloads"),
    path.join(home, "Desktop"),
    path.join(home, "Documents"),
    path.join(home, "Pictures"),
    path.join(home, ".cursor", "projects"),
    path.join(home, ".claude", "projects"),
  ];
}

function scorePathMatch(query: string, fullPath: string, entryName: string): number {
  const q = query.toLowerCase();
  const name = entryName.toLowerCase();
  const full = fullPath.toLowerCase();

  if (name === q) return 100;
  if (name.startsWith(q)) return 90;
  if (name.includes(q)) return 80;
  if (full.endsWith(path.sep + q)) return 95;
  if (full.includes(path.sep + q + path.sep)) return 70;
  if (full.includes(q)) return 50;
  return 0;
}

export function findLocalPaths(query: string, options: FindLocalPathsOptions = {}): FindLocalPathsResult {
  const trimmedQuery = query.trim();
  if (!trimmedQuery) {
    throw new Error("Query must not be empty");
  }

  if (path.isAbsolute(trimmedQuery)) {
    const resolved = path.resolve(trimmedQuery);
    if (!fs.existsSync(resolved)) {
      return { query: trimmedQuery, roots: [resolved], entries: [], truncated: false };
    }

    const stats = fs.statSync(resolved);
    return {
      query: trimmedQuery,
      roots: [path.dirname(resolved)],
      entries: [{
        path: resolved,
        name: path.basename(resolved),
        kind: stats.isDirectory() ? "directory" : "file",
        size: stats.isFile() ? stats.size : undefined,
        mtimeMs: stats.mtimeMs,
        isImage: stats.isFile() && isImageType(undefined, path.basename(resolved)),
        score: 1000,
      }],
      truncated: false,
    };
  }

  const roots = (options.roots?.length ? options.roots : defaultSearchRoots())
    .map((root) => path.resolve(root))
    .filter((root) => fs.existsSync(root));
  const recursive = options.recursive ?? true;
  const maxEntries = options.maxEntries ?? 50;
  const maxDepth = options.maxDepth ?? 4;
  const includeHidden = options.includeHidden ?? false;
  const directoriesOnly = options.directoriesOnly ?? false;
  const matches: LocalPathMatch[] = [];
  let truncated = false;

  const walk = (dirPath: string, depth: number): void => {
    if (truncated || depth > maxDepth) return;

    let dirents: fs.Dirent[];
    try {
      dirents = fs.readdirSync(dirPath, { withFileTypes: true });
    } catch {
      return;
    }

    for (const entry of dirents) {
      if (truncated) return;
      if (!includeHidden && entry.name.startsWith(".")) continue;

      const fullPath = path.join(dirPath, entry.name);
      let stat: fs.Stats;
      try {
        stat = fs.statSync(fullPath);
      } catch {
        continue;
      }

      if (!directoriesOnly || entry.isDirectory()) {
        const score = scorePathMatch(trimmedQuery, fullPath, entry.name);
        if (score > 0) {
          matches.push({
            path: fullPath,
            name: entry.name,
            kind: entry.isDirectory() ? "directory" : "file",
            size: entry.isFile() ? stat.size : undefined,
            mtimeMs: stat.mtimeMs,
            isImage: entry.isFile() && isImageType(undefined, entry.name),
            score,
          });
        }
      }

      if (recursive && entry.isDirectory()) {
        walk(fullPath, depth + 1);
      }
    }
  };

  for (const root of roots) {
    const rootStats = fs.statSync(root);
    if (!rootStats.isDirectory()) continue;
    const rootName = path.basename(root);
    const rootScore = scorePathMatch(trimmedQuery, root, rootName);
    if (rootScore > 0 && (!directoriesOnly || rootStats.isDirectory())) {
      matches.push({
        path: root,
        name: rootName,
        kind: "directory",
        mtimeMs: rootStats.mtimeMs,
        isImage: false,
        score: rootScore + 5,
      });
    }
    walk(root, 0);
    if (matches.length >= maxEntries) {
      truncated = true;
      break;
    }
  }

  const entries = matches
    .sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score;
      if (a.kind !== b.kind) return a.kind === "directory" ? -1 : 1;
      return a.path.localeCompare(b.path);
    })
    .filter((entry, index, array) => {
      if (index === 0) return true;
      const previous = array[index - 1];
      return previous ? entry.path !== previous.path : true;
    })
    .slice(0, maxEntries);

  truncated = truncated || matches.length > maxEntries;

  return { query: trimmedQuery, roots, entries, truncated };
}
