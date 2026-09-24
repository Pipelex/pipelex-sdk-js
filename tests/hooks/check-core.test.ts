/**
 * Decision-mapping tests for the `.mthds` hook core: per-stage verdicts in,
 * hook decisions out. Engine-free by design — the mappers must not care which
 * engine (WASM, API, MCP) produced a verdict.
 */

import { describe, expect, it } from "vitest";
import {
  decideAfterLint,
  decideAfterValidate,
  encodeOutcome,
  extractCodexMthdsTargets,
  extractMthdsFilePath,
  extractVibeMthdsFilePath,
  mergeOutcomes,
  carriesAddedLines,
  selectCodexTargets,
  truncate,
  uncheckedShellPatchNote,
  type CodexMthdsTarget,
} from "../../src/hooks/check-core.js";
import type { Diagnostic, ValidationErrorItem } from "../../src/models.js";

const FILE = "/work/demo.mthds";

const diagnostic = (overrides: Partial<Diagnostic> = {}): Diagnostic => ({
  kind: "syntax",
  severity: "error",
  message: "unexpected token",
  location: null,
  range: {
    start_offset: 0,
    end_offset: 1,
    start_line: 3,
    start_col: 7,
    end_line: 3,
    end_col: 8,
  },
  ...overrides,
});

const validationError = (overrides: Partial<ValidationErrorItem> = {}): ValidationErrorItem => ({
  category: "pipe_validation",
  message: "unknown concept",
  ...overrides,
});

describe("decideAfterLint", () => {
  it("passes on a clean lint", () => {
    expect(decideAfterLint(FILE, { status: "clean" })).toEqual({ kind: "pass" });
  });

  it("passes on an empty diagnostics list", () => {
    expect(decideAfterLint(FILE, { status: "diagnostics", diagnostics: [] })).toEqual({
      kind: "pass",
    });
  });

  it("passes when the lint engine is unavailable (fail-open)", () => {
    expect(decideAfterLint(FILE, { status: "unavailable" })).toEqual({ kind: "pass" });
  });

  it("blocks on diagnostics, naming the file, kind, message, and span", () => {
    const outcome = decideAfterLint(FILE, {
      status: "diagnostics",
      diagnostics: [diagnostic()],
    });
    expect(outcome.kind).toBe("block");
    if (outcome.kind !== "block") return;
    expect(outcome.reason).toContain(FILE);
    expect(outcome.reason).toContain("[syntax/error]");
    expect(outcome.reason).toContain("unexpected token");
    expect(outcome.reason).toContain("line 3, col 7");
  });

  it("renders a span-less diagnostic without a location suffix", () => {
    const outcome = decideAfterLint(FILE, {
      status: "diagnostics",
      diagnostics: [diagnostic({ range: null })],
    });
    expect(outcome.kind).toBe("block");
    if (outcome.kind !== "block") return;
    expect(outcome.reason).not.toContain("line");
  });

  it("keeps the location when the diagnostic has no range", () => {
    const outcome = decideAfterLint(FILE, {
      status: "diagnostics",
      diagnostics: [diagnostic({ range: null, location: "demo.extract" })],
    });
    expect(outcome.kind).toBe("block");
    if (outcome.kind !== "block") return;
    expect(outcome.reason).toContain("demo.extract");
    expect(outcome.reason).not.toContain("col");
  });

  it("renders both location and span when the diagnostic carries both", () => {
    const outcome = decideAfterLint(FILE, {
      status: "diagnostics",
      diagnostics: [diagnostic({ location: "demo.extract" })],
    });
    expect(outcome.kind).toBe("block");
    if (outcome.kind !== "block") return;
    expect(outcome.reason).toContain("demo.extract");
    expect(outcome.reason).toContain("line 3, col 7");
  });
});

describe("decideAfterValidate", () => {
  it("passes silently when the stage is unavailable", () => {
    expect(decideAfterValidate(FILE, { status: "unavailable" })).toEqual({ kind: "pass" });
  });

  it("passes silently on a valid bundle with no pending signatures", () => {
    expect(decideAfterValidate(FILE, { status: "valid", pendingSignatures: [] })).toEqual({
      kind: "pass",
    });
  });

  it("emits a non-blocking nudge on pending signatures", () => {
    const outcome = decideAfterValidate(FILE, {
      status: "valid",
      pendingSignatures: ["demo.extract", "demo.render"],
    });
    expect(outcome.kind).toBe("context");
    if (outcome.kind !== "context") return;
    expect(outcome.context).toContain("demo.extract, demo.render");
    expect(outcome.context).toContain("not yet runnable");
  });

  it("blocks with the server-rendered Markdown verbatim when present", () => {
    const markdown = "# Validation failed\n\n- pipe `demo.x`: unknown concept";
    const outcome = decideAfterValidate(FILE, {
      status: "invalid",
      validationErrors: [validationError()],
      renderedMarkdown: markdown,
    });
    expect(outcome).toEqual({ kind: "block", reason: markdown });
  });

  it("falls back to a client-side rendering with locators", () => {
    const outcome = decideAfterValidate(FILE, {
      status: "invalid",
      message: "Bundle failed validation.",
      validationErrors: [
        validationError({
          pipe_code: "extract",
          concept_code: "Invoice",
          field_name: "output",
          source: "demo.mthds",
        }),
      ],
    });
    expect(outcome.kind).toBe("block");
    if (outcome.kind !== "block") return;
    expect(outcome.reason).toContain("Validation failed for /work/demo.mthds");
    expect(outcome.reason).toContain("Bundle failed validation.");
    expect(outcome.reason).toContain("[pipe_validation] unknown concept");
    expect(outcome.reason).toContain(
      "pipe extract, concept Invoice, field output, source demo.mthds",
    );
  });

  it("blocks even when the invalid verdict carries no errors or message", () => {
    const outcome = decideAfterValidate(FILE, { status: "invalid", validationErrors: [] });
    expect(outcome.kind).toBe("block");
    if (outcome.kind !== "block") return;
    expect(outcome.reason).toContain("Bundle is invalid.");
  });

  it("shows the server message alone when the invalid verdict has no error items", () => {
    const outcome = decideAfterValidate(FILE, {
      status: "invalid",
      message: "Custom server message.",
      validationErrors: [],
    });
    expect(outcome.kind).toBe("block");
    if (outcome.kind !== "block") return;
    expect(outcome.reason).toContain("Validation failed for /work/demo.mthds");
    expect(outcome.reason).toContain("Custom server message.");
    expect(outcome.reason).not.toContain("Bundle is invalid.");
    expect(outcome.reason).not.toContain("[pipe_validation]");
  });
});

describe("extractMthdsFilePath", () => {
  it("extracts the file path of a .mthds Write/Edit", () => {
    const payload = JSON.stringify({
      tool_name: "Write",
      tool_input: { file_path: "/work/demo.mthds", content: "..." },
    });
    expect(extractMthdsFilePath(payload)).toBe("/work/demo.mthds");
  });

  it("returns null for a non-mthds file", () => {
    const payload = JSON.stringify({ tool_input: { file_path: "/work/demo.ts" } });
    expect(extractMthdsFilePath(payload)).toBeNull();
  });

  it("returns null on unparseable input (fail open)", () => {
    expect(extractMthdsFilePath("not json")).toBeNull();
  });

  it("returns null when tool_input or file_path is missing", () => {
    expect(extractMthdsFilePath("{}")).toBeNull();
    expect(extractMthdsFilePath(JSON.stringify({ tool_input: {} }))).toBeNull();
    expect(extractMthdsFilePath(JSON.stringify({ tool_input: { file_path: 42 } }))).toBeNull();
  });
});

describe("extractCodexMthdsTargets", () => {
  const HOOK_CWD = "/hook-cwd";
  const envelope = (body: string, extra: Record<string, unknown> = {}) =>
    JSON.stringify({ tool_name: "apply_patch", tool_input: { command: body }, ...extra });
  const paths = (stdinJson: string) =>
    extractCodexMthdsTargets(stdinJson, HOOK_CWD).targets.map((target) => target.path);

  it("extracts the files the patch leaves on disk, a moved file by its destination", () => {
    const stdin = envelope(
      "*** Begin Patch\n*** Update File: a.mthds\n@@\n*** Add File: sub/b.mthds\n+x\n" +
        "*** Update File: a.mthds\n*** Move to: c.mthds\n*** End Patch\n",
      { cwd: "/work" },
    );
    expect(paths(stdin)).toEqual(["/work/sub/b.mthds", "/work/c.mthds"]);
  });

  it("carries the path as written and the added lines", () => {
    const { targets } = extractCodexMthdsTargets(
      envelope("*** Update File: sub/a.mthds\n@@\n-old\n+new\n", { cwd: "/work" }),
      HOOK_CWD,
    );
    expect(targets).toEqual([
      {
        path: "/work/sub/a.mthds",
        writtenAs: "sub/a.mthds",
        addedLines: [["new"]],
        removedByPatch: false,
        confirm: false,
      },
    ]);
  });

  it("skips deleted files, Move from headers, and non-mthds files", () => {
    const stdin = envelope(
      "*** Delete File: gone.mthds\n*** Move from: old.mthds\n*** Update File: code.py\n",
    );
    expect(paths(stdin)).toEqual([]);
  });

  it("keeps an absolute path as it is", () => {
    expect(paths(envelope("*** Update File: /abs/a.mthds\n+x\n", { cwd: "/work" }))).toEqual([
      "/abs/a.mthds",
    ]);
  });

  it("anchors relative paths on the payload's cwd when it is absolute", () => {
    expect(paths(envelope("*** Update File: a.mthds\n", { cwd: "/session" }))).toEqual([
      "/session/a.mthds",
    ]);
  });

  it("falls back to the hook's working directory when cwd is missing or relative", () => {
    expect(paths(envelope("*** Update File: a.mthds\n"))).toEqual(["/hook-cwd/a.mthds"]);
    expect(paths(envelope("*** Update File: a.mthds\n", { cwd: "session" }))).toEqual([
      "/hook-cwd/a.mthds",
    ]);
    expect(paths(envelope("*** Update File: a.mthds\n", { cwd: 42 }))).toEqual([
      "/hook-cwd/a.mthds",
    ]);
  });

  it("returns empty on unparseable input or missing command", () => {
    expect(paths("not json")).toEqual([]);
    expect(paths(JSON.stringify({ tool_input: {} }))).toEqual([]);
  });

  describe("a patch run through the shell", () => {
    const PATCH = "*** Begin Patch\n*** Update File: broken.mthds\n@@\n+x\n*** End Patch";
    const shell = (script: string) =>
      JSON.stringify({ tool_name: "Bash", cwd: "/work", tool_input: { command: script } });

    it("resolves a relative path against the directory the script moved to", () => {
      const result = extractCodexMthdsTargets(
        shell(`cd sub && apply_patch <<'PATCH'\n${PATCH}\nPATCH\n`),
        HOOK_CWD,
      );
      expect(result).toEqual({
        fromShell: true,
        targets: [
          {
            path: "/work/sub/broken.mthds",
            writtenAs: "broken.mthds",
            addedLines: [["x"]],
            removedByPatch: false,
            confirm: true,
          },
        ],
        unplaced: [],
      });
    });

    it("lists a relative path under an unknown directory as unplaced", () => {
      const result = extractCodexMthdsTargets(
        shell(`cd "$DIR" && apply_patch <<'PATCH'\n${PATCH}\nPATCH\n`),
        HOOK_CWD,
      );
      expect(result).toEqual({ fromShell: true, targets: [], unplaced: ["broken.mthds"] });
    });

    it("lists every relative path of a script it cannot read as unplaced", () => {
      const result = extractCodexMthdsTargets(
        shell(`cd 'sub && apply_patch <<'PATCH'\n${PATCH}\nPATCH\n`),
        HOOK_CWD,
      );
      expect(result.unplaced).toEqual(["broken.mthds"]);
      expect(result.targets).toEqual([]);
    });

    it("keeps an absolute path wherever the script ran", () => {
      const result = extractCodexMthdsTargets(
        shell(
          `cd "$DIR" && apply_patch <<'PATCH'\n${PATCH.replace("broken.mthds", "/abs/broken.mthds")}\nPATCH\n`,
        ),
        HOOK_CWD,
      );
      expect(result.targets).toMatchObject([{ path: "/abs/broken.mthds", confirm: false }]);
      expect(result.unplaced).toEqual([]);
    });

    const DELETE = "*** Begin Patch\n*** Delete File: broken.mthds\n*** End Patch";

    it("keeps a file one patch edits and another deletes, compared by resolved path", () => {
      const script =
        `cd sub && apply_patch <<'P1'\n${PATCH}\nP1\n` +
        `cd .. && apply_patch <<'P2'\n${DELETE.replace("broken", "sub/broken")}\nP2\n`;
      expect(extractCodexMthdsTargets(shell(script), HOOK_CWD).targets).toMatchObject([
        { path: "/work/sub/broken.mthds", removedByPatch: true },
      ]);
    });

    it("keeps an edit when a patch in another unknown directory deletes the same name", () => {
      const script =
        `cd "$A" && apply_patch <<'P1'\n${PATCH}\nP1\n` +
        `cd "$B" && apply_patch <<'P2'\n${DELETE}\nP2\n`;
      expect(extractCodexMthdsTargets(shell(script), HOOK_CWD)).toEqual({
        fromShell: true,
        targets: [],
        unplaced: ["broken.mthds"],
      });
    });

    it("keeps an edit made in one branch and deleted in the other", () => {
      const script =
        `if test -f x; then apply_patch <<'P1'\n${PATCH}\nP1\n` +
        `else apply_patch <<'P2'\n${DELETE}\nP2\nfi\n`;
      expect(extractCodexMthdsTargets(shell(script), HOOK_CWD).targets).toMatchObject([
        { path: "/work/broken.mthds", addedLines: [["x"]], removedByPatch: true },
      ]);
    });

    it("confirms an absolute path that no patch command reads, and keeps one that does", () => {
      const absolute = PATCH.replace("broken.mthds", "/abs/broken.mthds");
      const staged = `cat > /tmp/p <<'EOF'\n${absolute}\nEOF\n`;
      expect(extractCodexMthdsTargets(shell(staged), HOOK_CWD).targets).toMatchObject([
        { path: "/abs/broken.mthds", confirm: true },
      ]);
      const unparsed = `cd 'sub && apply_patch <<'EOF'\n${absolute}\nEOF\n`;
      expect(extractCodexMthdsTargets(shell(unparsed), HOOK_CWD).targets).toMatchObject([
        { path: "/abs/broken.mthds", confirm: true },
      ]);
    });

    it("reads the added lines through the shell's quoting", () => {
      const lines = '+domain = \\"d\\"\n+prompt = \\$text\n+now = $(date)\n+plain';
      const quoted = PATCH.replace("+x", lines);
      expect(
        extractCodexMthdsTargets(shell(`apply_patch "${quoted}"\n`), HOOK_CWD).targets[0]!
          .addedLines,
      ).toEqual([['domain = "d"', "prompt = $text", "plain"]]);
      expect(
        extractCodexMthdsTargets(shell(`apply_patch <<EOF\n${quoted}\nEOF\n`), HOOK_CWD).targets[0]!
          .addedLines,
      ).toEqual([['domain = \\"d\\"', "prompt = $text", "plain"]]);
      expect(
        extractCodexMthdsTargets(shell(`apply_patch <<'EOF'\n${quoted}\nEOF\n`), HOOK_CWD)
          .targets[0]!.addedLines,
      ).toEqual([['domain = \\"d\\"', "prompt = \\$text", "now = $(date)", "plain"]]);
    });

    it("lists a patch held in a variable and applied later as unplaced", () => {
      const script = `PATCH=$(cat <<'EOF'\n${PATCH}\nEOF\n)\ncd sub && apply_patch "$PATCH"\n`;
      expect(extractCodexMthdsTargets(shell(script), HOOK_CWD)).toEqual({
        fromShell: true,
        targets: [],
        unplaced: ["broken.mthds"],
      });
    });

    it("reads the apply_patch tool's patch as the session directory's, whatever it holds", () => {
      const stdin = envelope(`cd sub\n${PATCH}\n`, { cwd: "/work" });
      expect(extractCodexMthdsTargets(stdin, HOOK_CWD)).toEqual({
        fromShell: false,
        targets: [
          {
            path: "/work/broken.mthds",
            writtenAs: "broken.mthds",
            addedLines: [["x"]],
            removedByPatch: false,
            confirm: false,
          },
        ],
        unplaced: [],
      });
    });

    it("reads a payload with no tool_name as the apply_patch tool's", () => {
      const stdin = JSON.stringify({ cwd: "/work", tool_input: { command: `cd sub\n${PATCH}` } });
      expect(extractCodexMthdsTargets(stdin, HOOK_CWD).targets[0]!.path).toBe("/work/broken.mthds");
    });
  });
});

describe("carriesAddedLines", () => {
  const CONTENT = 'domain = "demo"\n\n[pipe.a]\ntype = "PipeLLM"   \nprompt = "x"\n';

  it("finds the added lines in order, with other lines between them", () => {
    expect(carriesAddedLines(CONTENT, ['domain = "demo"', 'prompt = "x"'])).toBe(true);
  });

  it("refuses lines out of order, or one the file does not hold", () => {
    expect(carriesAddedLines(CONTENT, ['prompt = "x"', 'domain = "demo"'])).toBe(false);
    expect(carriesAddedLines(CONTENT, ['domain = "demo"', 'prompt = "y"'])).toBe(false);
  });

  it("ignores trailing whitespace on either side, and keeps leading whitespace", () => {
    expect(carriesAddedLines(CONTENT, ['type = "PipeLLM"', 'prompt = "x"  '])).toBe(true);
    expect(carriesAddedLines(CONTENT, ['  prompt = "x"'])).toBe(false);
  });

  it("skips blank added lines", () => {
    expect(carriesAddedLines(CONTENT, ["", "[pipe.a]", "   ", 'prompt = "x"'])).toBe(true);
  });

  it("reads CRLF content", () => {
    expect(carriesAddedLines(CONTENT.replaceAll("\n", "\r\n"), ["[pipe.a]", 'prompt = "x"'])).toBe(
      true,
    );
  });

  it("finds no evidence in a section that adds no line, or only blank ones", () => {
    expect(carriesAddedLines(CONTENT, [])).toBe(false);
    expect(carriesAddedLines(CONTENT, ["", "  "])).toBe(false);
  });
});

describe("selectCodexTargets", () => {
  const target = (overrides: Partial<CodexMthdsTarget> = {}): CodexMthdsTarget => ({
    path: "/work/sub/a.mthds",
    writtenAs: "a.mthds",
    addedLines: [["added"]],
    removedByPatch: false,
    confirm: true,
    ...overrides,
  });
  const select = (
    targets: CodexMthdsTarget[],
    files: Record<string, string>,
    unplaced: string[] = [],
  ) => selectCodexTargets({ fromShell: true, targets, unplaced }, (path) => files[path] ?? null);

  it("checks a file that carries the patch's added lines, with the content it read", () => {
    expect(select([target()], { "/work/sub/a.mthds": "x\nadded\n" })).toEqual({
      targets: [{ filePath: "/work/sub/a.mthds", content: "x\nadded\n" }],
      unchecked: [],
    });
  });

  it("names a file that does not carry them, rather than checking it", () => {
    expect(select([target()], { "/work/sub/a.mthds": "other\n" })).toEqual({
      targets: [],
      unchecked: ["a.mthds"],
    });
  });

  it("names a missing file, unless the patch itself removed it", () => {
    expect(select([target()], {}).unchecked).toEqual(["a.mthds"]);
    expect(select([target({ removedByPatch: true })], {})).toEqual({ targets: [], unchecked: [] });
  });

  it("names a file whose sections add no line, since nothing confirms it", () => {
    const selected = select([target({ addedLines: [[]] })], { "/work/sub/a.mthds": "x\n" });
    expect(selected).toEqual({ targets: [], unchecked: ["a.mthds"] });
  });

  it("checks a file that carries the lines of any envelope that wrote it", () => {
    const selected = select([target({ addedLines: [["first"], ["second"]] })], {
      "/work/sub/a.mthds": "second\n",
    });
    expect(selected.targets).toHaveLength(1);
  });

  it("checks a target that needs no confirming whenever its file exists", () => {
    const unconfirmed = target({ confirm: false, addedLines: [[]] });
    expect(select([unconfirmed], { "/work/sub/a.mthds": "x\n" }).targets).toHaveLength(1);
    expect(select([unconfirmed], {})).toEqual({ targets: [], unchecked: [] });
  });

  it("drops an absolute path it could not confirm without naming it", () => {
    const absolute = target({ path: "/abs/a.mthds", writtenAs: "/abs/a.mthds" });
    expect(select([absolute], { "/abs/a.mthds": "other\n" })).toEqual({
      targets: [],
      unchecked: [],
    });
    expect(select([absolute], {})).toEqual({ targets: [], unchecked: [] });
    expect(select([absolute], { "/abs/a.mthds": "added\n" }).targets).toHaveLength(1);
  });

  it("names the unplaced paths too, each once", () => {
    const selected = select([target()], {}, ["a.mthds", "b.mthds"]);
    expect(selected.unchecked).toEqual(["a.mthds", "b.mthds"]);
  });
});

describe("uncheckedShellPatchNote", () => {
  it("names one file", () => {
    expect(uncheckedShellPatchNote(["broken.mthds"])).toEqual({
      kind: "context",
      context:
        "The .mthds hook did not check `broken.mthds`: it could not confirm which file this " +
        "shell command patched. Name the file by its absolute path, or edit it with the " +
        "apply_patch tool, and the hook will check it.",
    });
  });

  it("names several files", () => {
    const note = uncheckedShellPatchNote(["a.mthds", "b.mthds", "c.mthds"]);
    expect(note).toEqual({
      kind: "context",
      context:
        "The .mthds hook did not check `a.mthds`, `b.mthds` and `c.mthds`: it could not " +
        "confirm which files this shell command patched. Name the files by their absolute " +
        "paths, or edit them with the apply_patch tool, and the hook will check them.",
    });
  });

  it("gives way to a block from another file, and joins another file's context", () => {
    const note = uncheckedShellPatchNote(["a.mthds"]);
    expect(mergeOutcomes([note, { kind: "block", reason: "lint failed" }])).toEqual({
      kind: "block",
      reason: "lint failed",
    });
    const merged = mergeOutcomes([{ kind: "context", context: "pending signatures" }, note]);
    expect(merged.kind).toBe("context");
    expect(merged.kind === "context" && merged.context.startsWith("pending signatures\n\n")).toBe(
      true,
    );
  });
});

describe("extractVibeMthdsFilePath", () => {
  it("reads the path from the tool_output/tool_input fallback chain with cwd", () => {
    const payload = JSON.stringify({
      tool_status: "success",
      cwd: "/work",
      tool_output: { file: "demo.mthds" },
    });
    expect(extractVibeMthdsFilePath(payload)).toEqual({ filePath: "demo.mthds", cwd: "/work" });
  });

  it("falls back to tool_output.path", () => {
    const payload = JSON.stringify({
      tool_status: "success",
      tool_output: { path: "x/demo.mthds" },
    });
    expect(extractVibeMthdsFilePath(payload)).toEqual({ filePath: "x/demo.mthds", cwd: undefined });
  });

  it("falls back to tool_input.file_path", () => {
    const payload = JSON.stringify({
      tool_status: "success",
      tool_input: { file_path: "x/demo.mthds" },
    });
    expect(extractVibeMthdsFilePath(payload)).toEqual({ filePath: "x/demo.mthds", cwd: undefined });
  });

  it("falls back to tool_input.path", () => {
    const payload = JSON.stringify({
      tool_status: "success",
      tool_input: { path: "x/demo.mthds" },
    });
    expect(extractVibeMthdsFilePath(payload)).toEqual({ filePath: "x/demo.mthds", cwd: undefined });
  });

  it("ignores failed tool calls and non-mthds paths", () => {
    expect(
      extractVibeMthdsFilePath(
        JSON.stringify({ tool_status: "error", tool_output: { file: "demo.mthds" } }),
      ),
    ).toBeNull();
    expect(
      extractVibeMthdsFilePath(
        JSON.stringify({ tool_status: "success", tool_output: { file: "demo.py" } }),
      ),
    ).toBeNull();
    expect(extractVibeMthdsFilePath("not json")).toBeNull();
  });
});

describe("mergeOutcomes", () => {
  it("passes when everything passes", () => {
    expect(mergeOutcomes([{ kind: "pass" }, { kind: "pass" }])).toEqual({ kind: "pass" });
    expect(mergeOutcomes([])).toEqual({ kind: "pass" });
  });

  it("any block wins and reasons are joined", () => {
    const merged = mergeOutcomes([
      { kind: "pass" },
      { kind: "block", reason: "first" },
      { kind: "context", context: "note" },
      { kind: "block", reason: "second" },
    ]);
    expect(merged).toEqual({ kind: "block", reason: "first\n\nsecond" });
  });

  it("contexts are joined when nothing blocks", () => {
    const merged = mergeOutcomes([
      { kind: "context", context: "a" },
      { kind: "pass" },
      { kind: "context", context: "b" },
    ]);
    expect(merged).toEqual({ kind: "context", context: "a\n\nb" });
  });
});

describe("truncate", () => {
  it("leaves short text alone", () => {
    expect(truncate("short")).toBe("short");
  });

  it("caps long text and reports the omission", () => {
    const long = "x".repeat(12000);
    const result = truncate(long);
    expect(result.length).toBeLessThan(10000);
    expect(result).toContain("[truncated, 2500 chars omitted]");
  });
});

describe("encodeOutcome", () => {
  it("encodes pass as empty output", () => {
    expect(encodeOutcome({ kind: "pass" })).toBe("");
  });

  it("encodes a block as the PostToolUse decision object", () => {
    const encoded = encodeOutcome({ kind: "block", reason: "why" });
    expect(JSON.parse(encoded)).toEqual({ decision: "block", reason: "why" });
  });

  it("encodes context as hookSpecificOutput.additionalContext", () => {
    const encoded = encodeOutcome({ kind: "context", context: "heads up" });
    expect(JSON.parse(encoded)).toEqual({
      hookSpecificOutput: {
        hookEventName: "PostToolUse",
        additionalContext: "heads up",
      },
    });
  });

  it("codex shares the claude dialect", () => {
    expect(encodeOutcome({ kind: "block", reason: "why" }, "codex")).toBe(
      encodeOutcome({ kind: "block", reason: "why" }, "claude"),
    );
    expect(encodeOutcome({ kind: "context", context: "note" }, "codex")).toBe(
      encodeOutcome({ kind: "context", context: "note" }, "claude"),
    );
  });

  it("vibe speaks deny / hook_specific_output.additional_context", () => {
    expect(JSON.parse(encodeOutcome({ kind: "block", reason: "why" }, "vibe"))).toEqual({
      decision: "deny",
      reason: "why",
    });
    expect(JSON.parse(encodeOutcome({ kind: "context", context: "note" }, "vibe"))).toEqual({
      decision: "allow",
      hook_specific_output: { additional_context: "note" },
    });
    expect(encodeOutcome({ kind: "pass" }, "vibe")).toBe("");
  });
});
