/**
 * Entry point of the `.mthds` post-edit hook bundle (`check.mjs`).
 *
 * One bundle serves all three harnesses behind `--platform=claude|codex|vibe`
 * (default claude) — the platform decides how the edited file(s) are extracted
 * from the stdin payload and which stdout dialect the decision is encoded in;
 * the pipeline itself is identical:
 *
 *   1. local lint  (`@pipelex/tools-wasm` — offline, no credentials) → BLOCK on diagnostics
 *   2. local format (same engine) → write back in place when changed
 *   3. API validate (`POST /v1/validate` via the SDK, `allow_signatures: true`)
 *      → BLOCK on an invalid verdict, non-blocking nudge on pending signatures
 *
 * Per-platform input: Claude reads `tool_input.file_path` (one file); Codex
 * parses the `apply_patch` envelope in `tool_input.command` (possibly several
 * files — outcomes are merged, any block wins); Vibe reads the
 * AfterToolInvocation payload (`tool_status` gate, path resolved against `cwd`).
 *
 * Failure posture (fail-open, per the networked-hook plan):
 * - no `.mthds` in the payload / unparseable stdin → pass silently
 * - WASM engine fails to load → whole hook unavailable → pass silently
 * - validate unavailable (no `PIPELEX_API_KEY`, network error, timeout, any
 *   non-2xx, bundle-gather overflow) → the local lint/format verdicts already
 *   applied; the validate stage passes silently
 *
 * The hook always exits 0; a block/deny is expressed on stdout, never via the
 * exit code.
 */

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { resolve as resolvePath } from "node:path";
import { PipelexApiClient } from "../client.js";
import {
  decideAfterLint,
  decideAfterValidate,
  encodeOutcome,
  extractCodexMthdsFiles,
  extractMthdsFilePath,
  extractVibeMthdsFilePath,
  mergeOutcomes,
  type HookOutcome,
  type HookPlatform,
  type LintStage,
  type ValidateStage,
} from "./check-core.js";
import { gatherBundle } from "./bundle-gather.js";

/** Per-request ceiling on the one network call — well under the hook's overall timeout. */
const VALIDATE_TIMEOUT_MS = 10_000;

type ToolsWasmModule = typeof import("@pipelex/tools-wasm");

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks).toString("utf-8");
}

function parsePlatform(argv: string[]): HookPlatform {
  for (const arg of argv) {
    if (arg.startsWith("--platform=")) {
      const value = arg.slice("--platform=".length);
      if (value === "claude" || value === "codex" || value === "vibe") {
        return value;
      }
    }
  }
  return "claude";
}

/** The absolute paths of edited `.mthds` files that exist on disk, per platform. */
function resolveTargets(platform: HookPlatform, stdinJson: string): string[] {
  let candidates: string[];
  switch (platform) {
    case "claude": {
      const filePath = extractMthdsFilePath(stdinJson);
      candidates = filePath ? [filePath] : [];
      break;
    }
    case "codex": {
      candidates = extractCodexMthdsFiles(stdinJson).map((raw) => resolvePath(process.cwd(), raw));
      break;
    }
    case "vibe": {
      const extracted = extractVibeMthdsFilePath(stdinJson);
      candidates = extracted
        ? [resolvePath(extracted.cwd ?? process.cwd(), extracted.filePath)]
        : [];
      break;
    }
  }
  // Deleted/renamed-away files have nothing to check (Codex envelopes list
  // paths that may not survive the patch; Claude edits can race a delete).
  return candidates.filter((filePath) => existsSync(filePath));
}

/**
 * Load the WASM engine. The one-line "deprecated parameters" warning the
 * wasm-bindgen loader glue prints on first initialize is dropped — it is
 * upstream noise, not a hook diagnostic.
 */
async function loadEngine(): Promise<ToolsWasmModule> {
  const engine = await import("@pipelex/tools-wasm");
  /* eslint-disable no-console */
  const originalWarn = console.warn;
  console.warn = (...args: unknown[]) => {
    if (typeof args[0] === "string" && args[0].includes("deprecated parameters")) {
      return;
    }
    originalWarn.apply(console, args);
  };
  try {
    await engine.initialize();
  } finally {
    console.warn = originalWarn;
  }
  /* eslint-enable no-console */
  return engine;
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error("validate request timed out")), timeoutMs);
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Run the networked validate stage. Every no-verdict condition maps to
 * `unavailable` — a machine consumer branches on the structured verdict,
 * never on transport.
 */
async function runValidateStage(filePath: string): Promise<ValidateStage> {
  if (!process.env.PIPELEX_API_KEY) {
    return { status: "unavailable" };
  }
  const gathered = gatherBundle(filePath);
  if (!gathered.ok) {
    return { status: "unavailable" };
  }
  try {
    const client = new PipelexApiClient();
    const result = await withTimeout(
      client.validateFiles(gathered.files, { allowSignatures: true }),
      VALIDATE_TIMEOUT_MS,
    );
    if (result.is_valid === true) {
      return {
        status: "valid",
        pendingSignatures: Array.isArray(result.pending_signatures)
          ? result.pending_signatures
          : [],
      };
    }
    if (result.is_valid === false) {
      return {
        status: "invalid",
        message: result.message,
        validationErrors: Array.isArray(result.validation_errors) ? result.validation_errors : [],
        renderedMarkdown: result.rendered_markdown,
      };
    }
    return { status: "unavailable" }; // no discriminant — no verdict
  } catch {
    return { status: "unavailable" };
  }
}

/** Synchronous fd-1 write — the process exits right after, an async write could truncate. */
function emit(outcome: HookOutcome, platform: HookPlatform): void {
  const encoded = encodeOutcome(outcome, platform);
  if (encoded) {
    writeFileSync(1, encoded);
  }
}

/** Synchronous fd-2 write, for the same reason. */
function warn(message: string): void {
  writeFileSync(2, `[mthds-hook] ${message}\n`);
}

/** The full pipeline on one edited file: lint → format write-back → validate. */
async function checkOneFile(engine: ToolsWasmModule, filePath: string): Promise<HookOutcome> {
  let content: string;
  try {
    content = readFileSync(filePath, "utf-8");
  } catch {
    return { kind: "pass" }; // file gone since the existence check — nothing to gate
  }

  // Stage 1 — local lint
  const lintStage: LintStage = {
    status: "diagnostics",
    diagnostics: engine.lintMthds(content).diagnostics,
  };
  const lintOutcome = decideAfterLint(filePath, lintStage);
  if (lintOutcome.kind !== "pass") {
    return lintOutcome;
  }

  // Stage 2 — local format, write back in place (mirrors `plxt fmt`)
  try {
    const formatted = engine.formatMthds(content);
    if (formatted.changed) {
      writeFileSync(filePath, formatted.formatted);
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    warn(`Warning: format failed: ${message}`);
  }

  // Stage 3 — API validate
  return decideAfterValidate(filePath, await runValidateStage(filePath));
}

async function main(): Promise<void> {
  const platform = parsePlatform(process.argv.slice(2));
  const filePaths = resolveTargets(platform, await readStdin());
  if (filePaths.length === 0) {
    return;
  }

  let engine: ToolsWasmModule;
  try {
    engine = await loadEngine();
  } catch {
    return; // engine unavailable — whole hook fails open
  }

  const outcomes: HookOutcome[] = [];
  for (const filePath of filePaths) {
    outcomes.push(await checkOneFile(engine, filePath));
  }
  emit(mergeOutcomes(outcomes), platform);
}

main()
  .catch((err: unknown) => {
    // Fail open: an unexpected hook fault must never block the write.
    const message = err instanceof Error ? err.message : String(err);
    warn(`Hook error (fail-open): ${message}`);
  })
  .finally(() => {
    // The WASM engine (and any raced-out fetch) can hold the event loop open;
    // the decision is already flushed (synchronous fd writes), so end the
    // process deterministically.
    process.exit(0);
  });
