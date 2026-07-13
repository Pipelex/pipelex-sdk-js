/**
 * E2E suite for the build projections — `buildInputs`, `buildOutput`, `buildRunner` —
 * exercised against a LIVE pipelex-api server (no fetch mocks).
 *
 * Run with `make test-e2e` (or `npm run test:e2e`) against a local runner:
 *
 *     PIPELEX_E2E_BASE_URL=http://localhost:8081 npm run test:e2e
 *
 * These are the tests the unit suite cannot write. Every mock in the repo agrees
 * with the client about the field names, so a typo in the request body (`file` for
 * `files`, a bare `pipe_code` for the qualified `pipe_ref`) is invisible until a
 * real server parses it. That is exactly what this suite catches.
 *
 * The through-line is the verdict discipline the build routes share with `validate`:
 * an unresolvable CLOSURE is a produced verdict on a **200** (`is_valid: false` +
 * `validation_errors[]`), while an unresolvable REQUEST — a `pipe_ref` naming nothing,
 * an omitted one the closure cannot default, the reserved `method_ref` — is non-2xx
 * and surfaces as the typed `ApiResponseError`.
 *
 * The bundles below are the pipelex-api server's own build-route fixtures
 * (`tests/unit/_constants.py`), reused verbatim so both sides test one closure.
 */

import { beforeAll, describe, expect, it } from "vitest";
import { PipelexApiClient } from "../../src/client.js";
import { ApiResponseError } from "../../src/errors.js";
import type {
  BuildInputsValidReport,
  BuildOutputValidReport,
  BuildRunnerValidReport,
  CrateInvalidReport,
} from "../../src/models.js";

const BASE_URL = process.env.PIPELEX_E2E_BASE_URL ?? "http://localhost:8081";

// ── Fixtures ─────────────────────────────────────────────────────────────

/** One domain, one pipe, one declared input — the closure that defaults cleanly to `smoke.echo`. */
const VALID_BUNDLE = `domain = "smoke"
main_pipe = "echo"

[pipe.echo]
type = "PipeLLM"
description = "Echo"
inputs = { text = "Text" }
output = "Text"
prompt = "@text"
`;

/** Declares NO main_pipe — the closure whose pipe selector cannot be defaulted (422 when omitted). */
const NO_MAIN_PIPE_BUNDLE = `domain = "nomain"

[pipe.echo]
type = "PipeLLM"
description = "Echo"
inputs = { text = "Text" }
output = "Text"
prompt = "@text"
`;

/** A second domain with its own main_pipe — alongside VALID_BUNDLE the default is AMBIGUOUS (422). */
const SECOND_MAIN_PIPE_BUNDLE = `domain = "other"
main_pipe = "shout"

[pipe.shout]
type = "PipeLLM"
description = "Shout"
inputs = { text = "Text" }
output = "Text"
prompt = "@text"
`;

/**
 * An INVALID closure — `main_pipe` is not even a legal pipe code.
 *
 * Deliberately this failure and not "main_pipe names a pipe that does not exist":
 * the syntax arm is the one whose diagnostic carries the structured locators
 * (`source`, `error_type`, `domain_code`), so it is what pins source-label threading.
 * The missing-pipe arm currently reports its source in the message PROSE only, with
 * the structured `source` field unset — an engine-side gap, tracked as a follow-up.
 */
const INVALID_BUNDLE = `domain = "broken"
description = "Invalid main_pipe"
main_pipe = "Not A Valid Pipe Code!"

[concept.Customer]
description = "A customer"
`;

// ── Suite ────────────────────────────────────────────────────────────────

const client = new PipelexApiClient({ baseUrl: BASE_URL, apiKey: "e2e-test" });

beforeAll(async () => {
  try {
    await client.health();
  } catch (err) {
    throw new Error(
      `No pipelex-api server reachable at ${BASE_URL}. Start one (e.g. in ../pipelex-api) ` +
        `or point PIPELEX_E2E_BASE_URL at a running instance.`,
      { cause: err },
    );
  }
});

describe("e2e buildInputs (/v1/build/inputs)", () => {
  it("renders the json template, defaulting the pipe selector to the closure's main_pipe", async () => {
    const result = await client.buildInputs({ files: [{ content: VALID_BUNDLE }] });

    expect(result.is_valid).toBe(true);
    const report = result as BuildInputsValidReport;
    // The server RESOLVED the ref; a bare `echo` would break the valid arm's own promise.
    expect(report.pipe_ref).toBe("smoke.echo");
    // Absent, not null — the selector was defaulted, never submitted.
    expect(report.requested_pipe_ref).toBeUndefined();
    expect(report.format).toBe("json");
    expect(report.inputs).toEqual({ text: expect.any(String) });
    expect(report.inputs_toml).toBeUndefined();
  });

  it("echoes an explicitly submitted qualified pipe_ref as both requested and resolved", async () => {
    const result = await client.buildInputs({
      files: [{ content: VALID_BUNDLE, source: "smoke.mthds" }],
      pipe_ref: "smoke.echo",
    });

    const report = result as BuildInputsValidReport;
    expect(report.pipe_ref).toBe("smoke.echo");
    expect(report.requested_pipe_ref).toBe("smoke.echo");
  });

  it("carries a toml template as raw text in inputs_toml, with inputs absent", async () => {
    const result = await client.buildInputs({
      files: [{ content: VALID_BUNDLE }],
      format: "toml",
    });

    const report = result as BuildInputsValidReport;
    expect(report.format).toBe("toml");
    expect(typeof report.inputs_toml).toBe("string");
    // The concept comment is what a parsed-dict shape would have destroyed — D3's whole point.
    expect(report.inputs_toml).toContain("concept");
    expect(report.inputs).toBeUndefined();
  });

  it("serves the explicit envelope — the ceremonial {concept, content} shape per input", async () => {
    const result = await client.buildInputs({
      files: [{ content: VALID_BUNDLE }],
      explicit: true,
    });

    const report = result as BuildInputsValidReport;
    expect(report.explicit).toBe(true);
    expect(report.inputs!.text).toMatchObject({ concept: expect.any(String) });
  });
});

describe("e2e buildOutput (/v1/build/output)", () => {
  it("returns the output concept as a parsed object under `output` for the default schema format", async () => {
    const result = await client.buildOutput({ files: [{ content: VALID_BUNDLE }] });

    expect(result.is_valid).toBe(true);
    const report = result as BuildOutputValidReport;
    expect(report.format).toBe("schema");
    expect(report.output).toMatchObject({ concept: "native.Text" });
    expect(report.output_python).toBeUndefined();
  });

  it("returns Python source under `output_python`, with `output` absent", async () => {
    // This arm was a hard 500 before the migration: the route json.loads()-ed every
    // format. It is the reason the valid arm splits object-vs-text at all.
    const result = await client.buildOutput({
      files: [{ content: VALID_BUNDLE }],
      format: "python",
    });

    const report = result as BuildOutputValidReport;
    expect(report.format).toBe("python");
    expect(typeof report.output_python).toBe("string");
    expect(report.output_python!.length).toBeGreaterThan(0);
    expect(report.output).toBeUndefined();
  });
});

describe("e2e buildRunner (/v1/build/runner)", () => {
  it("returns a runner script plus its stamped structures projection", async () => {
    const result = await client.buildRunner({
      files: [{ content: VALID_BUNDLE }],
      pipe_ref: "smoke.echo",
    });

    expect(result.is_valid).toBe(true);
    const report = result as BuildRunnerValidReport;
    expect(report.pipe_ref).toBe("smoke.echo");
    expect(report.python_code.length).toBeGreaterThan(0);
    expect(report.structures.directory.length).toBeGreaterThan(0);
    expect(report.structures.lock_filename.length).toBeGreaterThan(0);
    expect(report.structures.artifacts.length).toBeGreaterThan(0);
    for (const artifact of report.structures.artifacts) {
      expect(artifact.path.length).toBeGreaterThan(0);
      expect(artifact.content.length).toBeGreaterThan(0);
    }
  });
});

describe("e2e build verdicts — an invalid CLOSURE is a 200, never a throw", () => {
  it("returns is_valid: false with structured validation_errors for a broken closure", async () => {
    const result = await client.buildInputs({
      files: [{ content: INVALID_BUNDLE, source: "bundles/broken.mthds" }],
    });

    // A consumer that only catches throws would render a success over an unusable result.
    expect(result.is_valid).toBe(false);
    const report = result as CrateInvalidReport;
    expect(report.validation_errors.length).toBeGreaterThan(0);
    for (const item of report.validation_errors) {
      expect(item.category).toBeTruthy();
      expect(item.message.length).toBeGreaterThan(0);
    }
  });

  it("threads the submitted per-file source label onto the diagnostics", async () => {
    const result = await client.buildOutput({
      files: [{ content: INVALID_BUNDLE, source: "bundles/broken.mthds" }],
    });

    const report = result as CrateInvalidReport;
    // The whole point of `files[{content, source}]` over bare content strings: an
    // invalid verdict can point at the file that caused it.
    expect(report.validation_errors.some((item) => item.source === "bundles/broken.mthds")).toBe(
      true,
    );
  });
});

describe("e2e build no-verdict arms — a bad REQUEST throws a typed ApiResponseError", () => {
  it("rejects a pipe_ref that names nothing in the closure as a 422", async () => {
    // Nothing about the closure is wrong — the caller named a pipe that isn't in it.
    const failure = client.buildInputs({
      files: [{ content: VALID_BUNDLE }],
      pipe_ref: "smoke.does_not_exist",
    });
    await expect(failure).rejects.toBeInstanceOf(ApiResponseError);
    await expect(failure).rejects.toMatchObject({ status: 422 });
  });

  it("rejects an omitted pipe_ref when the closure declares no main_pipe (422)", async () => {
    const failure = client.buildInputs({ files: [{ content: NO_MAIN_PIPE_BUNDLE }] });
    await expect(failure).rejects.toBeInstanceOf(ApiResponseError);
    await expect(failure).rejects.toMatchObject({ status: 422 });
  });

  it("rejects an omitted pipe_ref when the closure declares SEVERAL main_pipes (422)", async () => {
    const failure = client.buildInputs({
      files: [{ content: VALID_BUNDLE }, { content: SECOND_MAIN_PIPE_BUNDLE }],
    });
    await expect(failure).rejects.toBeInstanceOf(ApiResponseError);
    await expect(failure).rejects.toMatchObject({ status: 422 });
  });

  it("naming the pipe explicitly resolves the ambiguity the default could not", async () => {
    const result = await client.buildInputs({
      files: [{ content: VALID_BUNDLE }, { content: SECOND_MAIN_PIPE_BUNDLE }],
      pipe_ref: "other.shout",
    });

    const report = result as BuildInputsValidReport;
    expect(report.pipe_ref).toBe("other.shout");
  });

  it("answers 501 for the reserved method_ref — the registry does not exist yet", async () => {
    const failure = client.buildRunner({ method_ref: "acme/some-method@1" });
    await expect(failure).rejects.toBeInstanceOf(ApiResponseError);
    await expect(failure).rejects.toMatchObject({ status: 501 });
  });
});
