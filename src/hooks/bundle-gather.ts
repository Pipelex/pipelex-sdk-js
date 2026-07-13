/**
 * Bundle gathering for the validate stage: the multi-file set sent to
 * `POST /v1/validate` around an edited `.mthds` file.
 *
 * Mirrors what the plxt-era hook's `-L "$PARENT_DIR/"` did through the Python
 * runtime (`pipelex/libraries/library_utils.py`): a recursive `.mthds` scan of
 * the edited file's parent directory, skipping the runtime's excluded dirs.
 * Capped, because an under-supplied bundle can produce a FALSE invalid verdict
 * (missing cross-file refs) — on overflow the caller must treat validate as
 * unavailable rather than risk a wrong block.
 */

import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import type { MthdsFile } from "../client.js";

/** Mirror of pipelex's `scan_config.excluded_dirs` (dot-dirs are skipped wholesale). */
const EXCLUDED_DIRS = new Set([
  "venv",
  "env",
  "virtualenv",
  "__pycache__",
  "node_modules",
  "results",
]);

export interface GatherCaps {
  maxFiles: number;
  maxTotalBytes: number;
}

export const DEFAULT_GATHER_CAPS: GatherCaps = {
  maxFiles: 50,
  maxTotalBytes: 2 * 1024 * 1024,
};

export type GatherResult =
  { ok: true; files: MthdsFile[] } | { ok: false; reason: "overflow" | "unreadable" };

function walkMthdsFiles(dir: string, collected: string[]): void {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return; // unreadable subdirectory — skip, the cap check guards correctness
  }
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    if (entry.name.startsWith(".") || EXCLUDED_DIRS.has(entry.name)) {
      continue;
    }
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      walkMthdsFiles(full, collected);
    } else if (entry.isFile() && entry.name.endsWith(".mthds")) {
      collected.push(full);
    }
  }
}

/**
 * Gather the `.mthds` files under the edited file's parent directory, the
 * edited file first (absent any `main_pipe`, the server's primary blueprint is
 * the first content — make that the file being edited). Contents are read
 * fresh from disk, so a format write-back is already reflected.
 */
export function gatherBundle(
  editedFilePath: string,
  caps: GatherCaps = DEFAULT_GATHER_CAPS,
): GatherResult {
  const editedAbs = resolve(editedFilePath);
  const parentDir = dirname(editedAbs);

  const paths: string[] = [];
  walkMthdsFiles(parentDir, paths);

  const ordered = [editedAbs, ...paths.filter((path) => resolve(path) !== editedAbs)];
  if (ordered.length > caps.maxFiles) {
    return { ok: false, reason: "overflow" };
  }

  let totalBytes = 0;
  for (const path of ordered) {
    try {
      totalBytes += statSync(path).size;
    } catch {
      return { ok: false, reason: "unreadable" };
    }
  }
  if (totalBytes > caps.maxTotalBytes) {
    return { ok: false, reason: "overflow" };
  }

  const files: MthdsFile[] = [];
  for (const path of ordered) {
    try {
      files.push({ content: readFileSync(path, "utf-8"), uri: relative(parentDir, path) });
    } catch {
      return { ok: false, reason: "unreadable" };
    }
  }
  return { ok: true, files };
}
