/**
 * E2E suite for the diagnostic surfaces — `lint`, `format`, and `validate` —
 * exercised against a LIVE pipelex-api server (no fetch mocks).
 *
 * Run with `make test-e2e` (or `npm run test:e2e`) against a local runner:
 *
 *     PIPELEX_E2E_BASE_URL=http://localhost:8081 npm run test:e2e
 *
 * The suite fails fast with a clear message when the server is unreachable —
 * e2e runs are explicitly invoked, so a missing server is an error, not a skip.
 *
 * The through-line is the diagnostic-endpoint contract: a malformed bundle is a
 * produced VERDICT on a 200 (`diagnostics[]` / `is_valid: false`), never a thrown
 * error; only a no-verdict condition (e.g. malformed formatter options) is non-2xx.
 */

import { beforeAll, describe, expect, it } from "vitest";
import { PipelexApiClient } from "../../src/client.js";
import { ApiResponseError } from "../../src/errors.js";
import type { PipelexInvalidReport, PipelexValidationReport } from "../../src/models.js";

const BASE_URL = process.env.PIPELEX_E2E_BASE_URL ?? "http://localhost:8081";

// ── Fixtures ─────────────────────────────────────────────────────────────

/** A correct, canonical bundle — lints clean, formats to itself, validates. */
const VALID_BUNDLE = `domain      = "quick_start"
description = "Discovering Pipelex"
main_pipe   = "hello_world"

[pipe.hello_world]
type = "PipeLLM"
description = "Write text about Hello World."
output = "Text"
prompt = """
Write a haiku about Hello World.
"""
`;

/** The same bundle with the alignment crunched — semantically identical, non-canonical. */
const UNFORMATTED_BUNDLE = VALID_BUNDLE.replace(
  'domain      = "quick_start"',
  'domain="quick_start"',
);

/** TOML that does not parse — a syntax-level failure. */
const SYNTAX_BROKEN_BUNDLE = `domain =
[pipe.
`;

/** Parses as TOML but violates the MTHDS schema (`definition` is not a valid key). */
const SCHEMA_BROKEN_BUNDLE = `domain = "demo"
definition = "A demo"

[pipe.hello]
type = "PipeLLM"
definition = "Say hi"
output = "Text"
prompt = "Say hi"
`;

/** Structurally fine TOML/schema, but the bundle wiring is broken (main_pipe missing). */
const INVALID_WIRING_BUNDLE = `domain = "demo"
description = "A demo"
main_pipe = "does_not_exist"

[pipe.hello]
type = "PipeLLM"
description = "Say hi."
output = "Text"
prompt = "Say hi"
`;

// ── Suite ────────────────────────────────────────────────────────────────

// See build.e2e.ts: the OSS default is AUTH_MODE=none, but an auth-enabled target
// needs a real token or /health passes while every /v1 call 401s.
const client = new PipelexApiClient({
  baseUrl: BASE_URL,
  apiKey: process.env.PIPELEX_API_KEY || "e2e-test",
});

beforeAll(async () => {
  try {
    // `/v1/version`, not the origin-level `/health`: only this one is served by BOTH a
    // bare runner and a hosted origin, so the probe stays honest wherever BASE_URL points.
    await client.version();
  } catch (err) {
    throw new Error(
      `No pipelex-api reachable at ${BASE_URL}. Start one (e.g. in ../pipelex-api) ` +
        `or point PIPELEX_E2E_BASE_URL (shell or .env) at a running instance.`,
      { cause: err },
    );
  }
});

describe("e2e lint (/v1/lint)", () => {
  it("returns zero diagnostics for a correct bundle", async () => {
    const result = await client.lint(VALID_BUNDLE, "hello_world.mthds");
    expect(result.diagnostics).toEqual([]);
  });

  it("returns syntax diagnostics with source ranges for a bundle that does not parse", async () => {
    const result = await client.lint(SYNTAX_BROKEN_BUNDLE);
    expect(result.diagnostics.length).toBeGreaterThan(0);
    for (const diagnostic of result.diagnostics) {
      expect(diagnostic.kind).toBe("syntax");
      expect(diagnostic.severity).toBe("error");
      expect(diagnostic.message.length).toBeGreaterThan(0);
    }
    // Syntax diagnostics carry a populated span with 1-based coordinates.
    const range = result.diagnostics[0]!.range;
    expect(range).not.toBeNull();
    expect(range!.start_line).toBeGreaterThanOrEqual(1);
    expect(range!.start_col).toBeGreaterThanOrEqual(1);
    expect(range!.end_offset).toBeGreaterThanOrEqual(range!.start_offset);
  });

  it("returns schema diagnostics for valid TOML that violates the MTHDS schema", async () => {
    const result = await client.lint(SCHEMA_BROKEN_BUNDLE);
    expect(result.diagnostics.length).toBeGreaterThan(0);
    expect(result.diagnostics.every((d) => d.kind === "schema")).toBe(true);
    // The offending key is named in the message and the pipe-level violation is located.
    expect(result.diagnostics.some((d) => d.message.includes("definition"))).toBe(true);
    expect(result.diagnostics.some((d) => d.location === "pipe.hello")).toBe(true);
  });
});

describe("e2e format (/v1/format)", () => {
  it("is a no-op on an already-canonical bundle", async () => {
    const result = await client.format(VALID_BUNDLE);
    expect(result.changed).toBe(false);
    expect(result.formatted).toBe(VALID_BUNDLE);
    expect(result.diagnostics).toEqual([]);
  });

  it("canonicalizes a non-canonical bundle, idempotently", async () => {
    const first = await client.format(UNFORMATTED_BUNDLE);
    expect(first.changed).toBe(true);
    expect(first.diagnostics).toEqual([]);
    // The canonical form of the crunched bundle is the canonical bundle itself…
    expect(first.formatted).toBe(VALID_BUNDLE);
    // …and formatting is idempotent: a second pass is a no-op.
    const second = await client.format(first.formatted);
    expect(second.changed).toBe(false);
    expect(second.formatted).toBe(first.formatted);
  });

  it("returns a syntax error as a 200 verdict with the content echoed unchanged", async () => {
    const result = await client.format(SYNTAX_BROKEN_BUNDLE);
    expect(result.changed).toBe(false);
    expect(result.formatted).toBe(SYNTAX_BROKEN_BUNDLE);
    expect(result.diagnostics.length).toBeGreaterThan(0);
    expect(result.diagnostics[0]!.kind).toBe("syntax");
  });

  it("rejects malformed formatter options as a 422 ApiResponseError (no verdict)", async () => {
    const failure = client.format(VALID_BUNDLE, { column_width: "wide" });
    await expect(failure).rejects.toBeInstanceOf(ApiResponseError);
    await expect(failure).rejects.toMatchObject({ status: 422 });
  });
});

describe("e2e validate (/v1/validate)", () => {
  it("returns is_valid: true with the structural artifacts for a correct bundle", async () => {
    const result = await client.validate([VALID_BUNDLE]);
    expect(result.is_valid).toBe(true);
    const report = result as PipelexValidationReport;
    expect(report.bundle_blueprint).toBeTruthy();
    expect(report.is_runnable).toBe(true);
    expect(report.validated_pipes.some((p) => p.pipe_ref === "quick_start.hello_world")).toBe(true);
    // The three fields a live server is the only witness for. `warnings` and
    // `liftable_pipes` are unconditional (they default to `[]` upstream); a clean
    // bundle exercises the empty case, which is the one a typed mirror gets wrong by
    // omitting the field entirely.
    expect(Array.isArray(report.warnings)).toBe(true);
    expect(Array.isArray(report.liftable_pipes)).toBe(true);
  });

  it("omits input_form unless the request names the view", async () => {
    const result = await client.validate([VALID_BUNDLE]);
    expect(result.is_valid).toBe(true);
    const report = result as PipelexValidationReport;
    // The gate itself, which only a live server witnesses: `input_form` is an opt-in
    // structured view, so a caller that names no token gets a body byte-identical to
    // one that omits `views` entirely.
    expect(report.input_form).toBeUndefined();
  });

  it("attaches input_form keyed like pipe_io_contracts when the view is asked for", async () => {
    const result = await client.validate([VALID_BUNDLE], false, undefined, undefined, [
      "input_form",
    ]);
    expect(result.is_valid).toBe(true);
    const report = result as PipelexValidationReport;
    expect(report.input_form).toBeDefined();
    // The invariant a renderer depends on: address a pipe's form by the ref it holds.
    expect(Object.keys(report.input_form ?? {}).sort()).toEqual(
      Object.keys(report.pipe_io_contracts).sort(),
    );
  });

  it("lenient-ignores an unsupported views token rather than refusing the request", async () => {
    const result = await client.validate([VALID_BUNDLE], false, undefined, undefined, [
      "not_a_supported_view",
    ]);
    expect(result.is_valid).toBe(true);
    expect((result as PipelexValidationReport).input_form).toBeUndefined();
  });

  it("returns is_valid: false with structured validation_errors for a broken bundle", async () => {
    const result = await client.validate([INVALID_WIRING_BUNDLE]);
    expect(result.is_valid).toBe(false);
    const report = result as PipelexInvalidReport;
    expect(report.validation_errors.length).toBeGreaterThan(0);
    for (const item of report.validation_errors) {
      expect(item.category).toBeTruthy();
      expect(item.message.length).toBeGreaterThan(0);
    }
  });

  it("returns a parse-level failure as an is_valid: false verdict, not a thrown error", async () => {
    const result = await client.validate([SYNTAX_BROKEN_BUNDLE]);
    expect(result.is_valid).toBe(false);
    const report = result as PipelexInvalidReport;
    // The structured-info invariant: even a parse failure carries at least one item.
    expect(report.validation_errors.length).toBeGreaterThan(0);
  });
});
