/**
 * Engine-agnostic core of the `.mthds` PostToolUse hook: the per-stage verdict
 * shapes and the mapping from verdicts to the hook's decision output.
 *
 * The three stages (lint, format, validate) are swappable engines — local WASM
 * today, `client.lint`/`client.format` as the documented fallback, MCP calls
 * later. Nothing in this module knows which engine produced a verdict; it only
 * maps verdict → decision, mirroring the Stage-3 model of the plxt-era hook:
 *
 * - lint diagnostics            → BLOCK (agent fixes the file)
 * - validate `is_valid: false`  → BLOCK (input-domain by construction: over the
 *   API a produced verdict is always a 200; server/config faults are non-2xx =
 *   no verdict = unavailable)
 * - validate valid + pending `PipeSignature`s → non-blocking additionalContext
 * - any stage unavailable       → fail-open (the other stages' verdicts stand)
 */

import type { Diagnostic, ValidationErrorItem } from "../models.js";

/** Verdict of the local lint stage. `unavailable` = engine failed to load. */
export type LintStage =
  | { status: "clean" }
  | { status: "diagnostics"; diagnostics: Diagnostic[] }
  | { status: "unavailable" };

/** Verdict of the networked validate stage. `unavailable` = no verdict could be produced. */
export type ValidateStage =
  | { status: "valid"; pendingSignatures: string[] }
  | {
      status: "invalid";
      message?: string;
      validationErrors: ValidationErrorItem[];
      renderedMarkdown?: string;
    }
  | { status: "unavailable" };

/** The hook's decision, prior to JSON encoding. */
export type HookOutcome =
  { kind: "pass" } | { kind: "block"; reason: string } | { kind: "context"; context: string };

/**
 * Which harness invoked the hook. Claude and Codex share the block /
 * `hookSpecificOutput` stdout protocol; Mistral Vibe speaks
 * deny / `hook_specific_output.additional_context`.
 */
export type HookPlatform = "claude" | "codex" | "vibe";

function parseJsonOrNull(stdinJson: string): unknown {
  try {
    return JSON.parse(stdinJson);
  } catch {
    return null; // fail open on unparseable input, mirroring the plxt-era hooks
  }
}

/**
 * Extract the edited `.mthds` path from the Claude PostToolUse stdin payload;
 * null = not this hook's business (fail open, mirroring the plxt-era hook,
 * which also passed silently on unparseable input).
 */
export function extractMthdsFilePath(stdinJson: string): string | null {
  const parsed = parseJsonOrNull(stdinJson);
  const filePath = (parsed as { tool_input?: { file_path?: unknown } } | null)?.tool_input
    ?.file_path;
  if (typeof filePath !== "string" || !filePath.endsWith(".mthds")) {
    return null;
  }
  return filePath;
}

/**
 * Extract every distinct `.mthds` path from a Codex PostToolUse(apply_patch)
 * payload. `apply_patch` is Codex's freeform multi-file write tool: the patch
 * envelope rides verbatim in `tool_input.command`, and the touched files are
 * its `*** Update File: / *** Add File: / *** Move to:` headers (`Delete
 * File:` and `Move from:` are skipped — the file no longer exists post-patch).
 * Mirrors `mthds-agent codex hook`'s parser. Paths come back as written in
 * the envelope (usually cwd-relative); the caller resolves and existence-checks.
 */
export function extractCodexMthdsFiles(stdinJson: string): string[] {
  const parsed = parseJsonOrNull(stdinJson);
  const command = (parsed as { tool_input?: { command?: unknown } } | null)?.tool_input?.command;
  if (typeof command !== "string") {
    return [];
  }
  const headerRe = /^\*\*\* (?:Update File|Add File|Move to):\s*(.+\.mthds)\s*$/gm;
  const seen = new Set<string>();
  let match: RegExpExecArray | null;
  while ((match = headerRe.exec(command)) !== null) {
    seen.add(match[1]!.trim());
  }
  return Array.from(seen);
}

/**
 * Extract the edited `.mthds` path from a Mistral Vibe stable `post_tool`
 * payload, plus the cwd to resolve it against. Only successful tool calls
 * count (`tool_status: "success"`); the path rides in `tool_output.file` /
 * `tool_output.path` / `tool_input.file_path` / `tool_input.path` — the same
 * fallback chain as the plxt-era Vibe hook.
 */
export function extractVibeMthdsFilePath(
  stdinJson: string,
): { filePath: string; cwd?: string } | null {
  const parsed = parseJsonOrNull(stdinJson) as {
    tool_status?: unknown;
    cwd?: unknown;
    tool_output?: { file?: unknown; path?: unknown };
    tool_input?: { file_path?: unknown; path?: unknown };
  } | null;
  if (!parsed || parsed.tool_status !== "success") {
    return null;
  }
  const candidates = [
    parsed.tool_output?.file,
    parsed.tool_output?.path,
    parsed.tool_input?.file_path,
    parsed.tool_input?.path,
  ];
  const filePath = candidates.find(
    (value): value is string => typeof value === "string" && value.endsWith(".mthds"),
  );
  if (!filePath) {
    return null;
  }
  return { filePath, cwd: typeof parsed.cwd === "string" ? parsed.cwd : undefined };
}

/**
 * Merge per-file outcomes (Codex's `apply_patch` can touch several `.mthds`
 * files in one call) into the single decision the hook emits: any block wins
 * (reasons joined), else contexts are joined, else pass.
 */
export function mergeOutcomes(outcomes: HookOutcome[]): HookOutcome {
  const blocks = outcomes.filter((outcome) => outcome.kind === "block");
  if (blocks.length > 0) {
    return { kind: "block", reason: truncate(blocks.map((block) => block.reason).join("\n\n")) };
  }
  const contexts = outcomes.filter((outcome) => outcome.kind === "context");
  if (contexts.length > 0) {
    return {
      kind: "context",
      context: truncate(contexts.map((context) => context.context).join("\n\n")),
    };
  }
  return { kind: "pass" };
}

/** Cap on emitted reason/context bodies — same guard as the plxt-era hook. */
const MAX_OUTPUT_CHARS = 9500;

export function truncate(text: string): string {
  if (text.length <= MAX_OUTPUT_CHARS) {
    return text;
  }
  const omitted = text.length - MAX_OUTPUT_CHARS;
  return `${text.slice(0, MAX_OUTPUT_CHARS)}\n\n[truncated, ${omitted} chars omitted]`;
}

/**
 * One diagnostic as an agent-actionable line: severity, locators, message.
 * `location` and `range` are independent — a schema/semantic diagnostic can name
 * its target (a pipe, a concept) without a byte span, so both render when present.
 */
function renderDiagnosticLine(diagnostic: Diagnostic): string {
  const locators = [
    diagnostic.location,
    diagnostic.range && `line ${diagnostic.range.start_line}, col ${diagnostic.range.start_col}`,
  ].filter(Boolean);
  const span = locators.length > 0 ? ` (${locators.join(", ")})` : "";
  return `- [${diagnostic.kind}/${diagnostic.severity}] ${diagnostic.message}${span}`;
}

/**
 * Map the lint verdict to a decision. Every engine diagnostic is an error by
 * construction (the shared Rust engine emits `severity: "error"` only), so any
 * diagnostic blocks — the same bar as `plxt lint`'s non-zero exit.
 */
export function decideAfterLint(filePath: string, lint: LintStage): HookOutcome {
  if (lint.status !== "diagnostics" || lint.diagnostics.length === 0) {
    return { kind: "pass" };
  }
  const lines = [
    `MTHDS lint errors in ${filePath}:`,
    "",
    ...lint.diagnostics.map(renderDiagnosticLine),
  ];
  return { kind: "block", reason: truncate(lines.join("\n")) };
}

/** One validation error with its locators — mirror of the plxt-era rendering. */
function renderValidationErrorLine(item: ValidationErrorItem): string {
  const locators = [
    item.pipe_code && `pipe ${item.pipe_code}`,
    item.concept_code && `concept ${item.concept_code}`,
    item.field_name && `field ${item.field_name}`,
    item.source && `source ${item.source}`,
  ]
    .filter(Boolean)
    .join(", ");
  return `- [${item.category ?? "error"}] ${item.message ?? ""}${locators ? ` (${locators})` : ""}`;
}

/**
 * Map the validate verdict to a decision.
 *
 * Invalid blocks with the server-rendered Markdown verbatim when present (the
 * workspace's "surface output conventions": the wire is JSON, the agent reads
 * Markdown), falling back to a client-side rendering of `validation_errors[]`.
 * Valid passes, with a non-blocking nudge listing still-unimplemented
 * `PipeSignature`s. Unavailable passes silently — the local lint/format
 * verdicts already applied.
 */
export function decideAfterValidate(filePath: string, validate: ValidateStage): HookOutcome {
  switch (validate.status) {
    case "unavailable":
      return { kind: "pass" };
    case "valid": {
      if (validate.pendingSignatures.length === 0) {
        return { kind: "pass" };
      }
      const context =
        "Bundle is valid but not yet runnable. Signatures still unimplemented (PipeSignature placeholders): " +
        validate.pendingSignatures.join(", ") +
        ". They mock their output on dry-run; implement them before running the method for real.";
      return { kind: "context", context: truncate(context) };
    }
    case "invalid": {
      if (validate.renderedMarkdown) {
        return { kind: "block", reason: truncate(validate.renderedMarkdown) };
      }
      const lines = [
        `Validation failed for ${filePath}:`,
        "",
        validate.message || "Bundle is invalid.",
      ];
      if (validate.validationErrors.length > 0) {
        lines.push("");
        lines.push(...validate.validationErrors.map(renderValidationErrorLine));
      }
      return { kind: "block", reason: truncate(lines.join("\n")) };
    }
  }
}

/**
 * Encode an outcome as the harness's stdout payload. `pass` is empty output;
 * the hook always exits 0. Claude and Codex share the block /
 * `hookSpecificOutput` protocol; Vibe speaks deny / `hook_specific_output`.
 */
export function encodeOutcome(outcome: HookOutcome, platform: HookPlatform = "claude"): string {
  switch (outcome.kind) {
    case "pass":
      return "";
    case "block":
      if (platform === "vibe") {
        return JSON.stringify({ decision: "deny", reason: outcome.reason }) + "\n";
      }
      return JSON.stringify({ decision: "block", reason: outcome.reason }) + "\n";
    case "context":
      if (platform === "vibe") {
        return (
          JSON.stringify({
            decision: "allow",
            hook_specific_output: { additional_context: outcome.context },
          }) + "\n"
        );
      }
      return (
        JSON.stringify({
          hookSpecificOutput: {
            hookEventName: "PostToolUse",
            additionalContext: outcome.context,
          },
        }) + "\n"
      );
  }
}
