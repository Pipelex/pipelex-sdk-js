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
  extractCodexMthdsFiles,
  extractMthdsFilePath,
  extractVibeMthdsFilePath,
  mergeOutcomes,
  truncate,
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

describe("extractCodexMthdsFiles", () => {
  const envelope = (body: string) => JSON.stringify({ tool_input: { command: body } });

  it("extracts Update/Add/Move-to targets, deduped", () => {
    const files = extractCodexMthdsFiles(
      envelope(
        "*** Begin Patch\n*** Update File: a.mthds\n@@\n*** Add File: sub/b.mthds\n" +
          "*** Update File: a.mthds\n*** Move to: c.mthds\n*** End Patch\n",
      ),
    );
    expect(files).toEqual(["a.mthds", "sub/b.mthds", "c.mthds"]);
  });

  it("skips Delete File and Move from headers, and non-mthds files", () => {
    const files = extractCodexMthdsFiles(
      envelope("*** Delete File: gone.mthds\n*** Move from: old.mthds\n*** Update File: code.py\n"),
    );
    expect(files).toEqual([]);
  });

  it("returns empty on unparseable input or missing command", () => {
    expect(extractCodexMthdsFiles("not json")).toEqual([]);
    expect(extractCodexMthdsFiles(JSON.stringify({ tool_input: {} }))).toEqual([]);
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
