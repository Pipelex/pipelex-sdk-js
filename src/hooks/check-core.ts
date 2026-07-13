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
 * Extract the edited `.mthds` path from the PostToolUse stdin payload;
 * null = not this hook's business (fail open, mirroring the plxt-era hook,
 * which also passed silently on unparseable input).
 */
export function extractMthdsFilePath(stdinJson: string): string | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdinJson);
  } catch {
    return null;
  }
  const filePath = (parsed as { tool_input?: { file_path?: unknown } } | null)?.tool_input
    ?.file_path;
  if (typeof filePath !== "string" || !filePath.endsWith(".mthds")) {
    return null;
  }
  return filePath;
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

/** One diagnostic as an agent-actionable line: severity, span, message. */
function renderDiagnosticLine(diagnostic: Diagnostic): string {
  const span = diagnostic.range
    ? ` (line ${diagnostic.range.start_line}, col ${diagnostic.range.start_col})`
    : "";
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
 * Encode an outcome as the Claude Code PostToolUse stdout payload.
 * `pass` is empty output; the hook always exits 0.
 */
export function encodeOutcome(outcome: HookOutcome): string {
  switch (outcome.kind) {
    case "pass":
      return "";
    case "block":
      return JSON.stringify({ decision: "block", reason: outcome.reason }) + "\n";
    case "context":
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
