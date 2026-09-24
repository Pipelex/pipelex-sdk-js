/**
 * Reader of Codex's `apply_patch` envelope, as sections rather than bare
 * header lines.
 *
 * A patch is `*** Begin Patch`, then one section per file, then `*** End
 * Patch`. A section opens with `*** Add File: <path>`, `*** Update File:
 * <path>` (optionally followed by `*** Move to: <path>`) or `*** Delete File:
 * <path>`, and holds the lines under it until the next header. Its `+` lines
 * are the lines the patch adds, which Codex writes to the file verbatim.
 *
 * The text read may be the patch alone (the `apply_patch` tool) or a whole
 * shell script with the patch inside it (Codex's `Bash` tool), so the reader
 * keeps each section's offset for the caller to place it in the script.
 */

/** One file's section of a patch. */
export interface PatchSection {
  kind: "add" | "update" | "delete";
  /** The path as the header wrote it, trimmed. */
  path: string;
  /** The destination of an `Update File` section's `Move to`, or null. */
  moveTo: string | null;
  /** Offset of the section's header line in the text read. */
  offset: number;
  /** The section's `+` lines, marker stripped, otherwise as written. */
  addedLines: string[];
}

/** A file the patch leaves on disk, with the section that last wrote it. */
export interface SurvivingFile {
  /** The path as the patch wrote it: the section's own, or its `Move to`. */
  path: string;
  section: PatchSection;
}

const SECTION_HEADER = /^\*\*\* (Add File|Update File|Delete File):\s*(.*?)\s*$/;
const MOVE_HEADER = /^\*\*\* Move to:\s*(.*?)\s*$/;
const ENVELOPE_BOUNDARY = /^\*\*\* (?:Begin|End) Patch\b/;
const MTHDS_PATH = /.\.mthds$/;

const SECTION_KINDS: Record<string, PatchSection["kind"]> = {
  "Add File": "add",
  "Update File": "update",
  "Delete File": "delete",
};

/**
 * Every section of every patch envelope in `text`, in order. The recognised
 * headers are anchored at the start of a line, as the `pipelex-plugins`
 * wrapper's pre-filter reads them; a `Move to` counts only inside an `Update
 * File` section, and a `Begin Patch` or `End Patch` line closes the section
 * before it, so script lines after a patch are not read as its content.
 */
export function readPatchSections(text: string): PatchSection[] {
  const sections: PatchSection[] = [];
  let current: PatchSection | null = null;
  let lineStart = 0;
  while (lineStart <= text.length) {
    const newline = text.indexOf("\n", lineStart);
    const lineEnd = newline === -1 ? text.length : newline;
    const line = text.slice(lineStart, lineEnd).replace(/\r$/, "");
    const header = SECTION_HEADER.exec(line);
    if (header) {
      current = null;
      if (header[2]) {
        current = {
          kind: SECTION_KINDS[header[1]!]!,
          path: header[2],
          moveTo: null,
          offset: lineStart,
          addedLines: [],
        };
        sections.push(current);
      }
    } else if (ENVELOPE_BOUNDARY.test(line)) {
      current = null;
    } else if (current) {
      const move = MOVE_HEADER.exec(line);
      if (move) {
        if (current.kind === "update" && current.moveTo === null && move[1]) {
          current.moveTo = move[1];
        }
      } else if (line.startsWith("+")) {
        current.addedLines.push(line.slice(1));
      }
    }
    if (newline === -1) {
      break;
    }
    lineStart = newline + 1;
  }
  return sections;
}

/**
 * The `.mthds` files that survive the sections, applied in order: an added or
 * updated file becomes a target, a moved file stops being one and its
 * destination becomes one, and a deleted file stops being one. Two paths name
 * the same file when `keyOf` gives them the same key, which lets the caller
 * compare paths resolved against the directory each section was applied in;
 * by default the paths are compared as written.
 */
export function patchTargets(
  sections: readonly PatchSection[],
  keyOf: (path: string, section: PatchSection) => string = (path) => path,
): SurvivingFile[] {
  const surviving = new Map<string, SurvivingFile>();
  for (const section of sections) {
    const key = keyOf(section.path, section);
    if (section.kind === "delete") {
      surviving.delete(key);
    } else if (section.moveTo !== null) {
      surviving.delete(key);
      surviving.set(keyOf(section.moveTo, section), { path: section.moveTo, section });
    } else {
      surviving.set(key, { path: section.path, section });
    }
  }
  return Array.from(surviving.values()).filter((file) => MTHDS_PATH.test(file.path));
}
