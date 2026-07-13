/**
 * The `/v1/build/*` migration onto the shared `files[]` envelope + typed verdicts.
 *
 * Two things are pinned here, and they are the two a consumer gets wrong:
 *
 * 1. **The request type IS the wire body.** Build requests are posted verbatim, so
 *    these tests assert the exact JSON that leaves the client — `files[{content,
 *    source?}]` and a QUALIFIED `pipe_ref`, never the retired `mthds_contents` /
 *    bare `pipe_code`.
 * 2. **The 200 is a verdict, not a payload.** An unresolvable closure comes back as
 *    a 200 `is_valid: false`, so a consumer that only catches throws would render a
 *    success over an unusable result. Only a no-verdict condition (unknown pipe_ref
 *    → 422, `method_ref` → 501) throws, and it throws the typed `ApiResponseError`.
 */

import { describe, it, expect, vi, afterEach } from "vitest";
import { PipelexApiClient } from "../src/client.js";
import { ApiResponseError } from "../src/errors.js";
import type {
  BuildInputsValidReport,
  BuildOutputValidReport,
  BuildRunnerValidReport,
  CrateInvalidReport,
} from "../src/models.js";

function makeClient(): PipelexApiClient {
  return new PipelexApiClient({ baseUrl: "http://localhost:8081", apiKey: "test-token" });
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

/** An RFC 7807 problem body, as the server renders every non-2xx. */
function problemResponse(status: number, detail: string): Response {
  return new Response(JSON.stringify({ status, title: "Error", detail }), {
    status,
    headers: { "Content-Type": "application/problem+json" },
  });
}

function postedBody(spy: ReturnType<typeof vi.spyOn>): unknown {
  const init = spy.mock.calls[0]![1] as RequestInit;
  return JSON.parse(init.body as string);
}

const INVALID_ARM: CrateInvalidReport = {
  is_valid: false,
  validation_errors: [{ category: "blueprint_validation", message: "boom", source: "a.mthds" }],
  message: "Closure is invalid",
};

describe("build routes — request envelope", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("posts the files[] envelope with per-file source labels and a qualified pipe_ref", async () => {
    const client = makeClient();
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(jsonResponse(200, { is_valid: true }));

    await client.buildInputs({
      files: [
        { content: "domain = 'smoke'", source: "smoke.mthds" },
        { content: "domain = 'other'" },
      ],
      pipe_ref: "smoke.echo",
      format: "json",
      explicit: false,
    });

    expect(fetchSpy.mock.calls[0]![0]).toBe("http://localhost:8081/v1/build/inputs");
    expect(postedBody(fetchSpy)).toEqual({
      files: [
        { content: "domain = 'smoke'", source: "smoke.mthds" },
        { content: "domain = 'other'" },
      ],
      pipe_ref: "smoke.echo",
      format: "json",
      explicit: false,
    });
  });

  it("omits pipe_ref entirely when the caller defers to the closure's main_pipe", async () => {
    const client = makeClient();
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(jsonResponse(200, { is_valid: true }));

    await client.buildOutput({ files: [{ content: "domain = 'smoke'" }] });

    // Not `pipe_ref: undefined` — the key must be absent, so the server defaults it.
    expect(postedBody(fetchSpy)).toEqual({ files: [{ content: "domain = 'smoke'" }] });
  });

  it("sends allow_signatures on /build/runner — the only build route that still takes it", async () => {
    const client = makeClient();
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(jsonResponse(200, { is_valid: true }));

    await client.buildRunner({
      files: [{ content: "domain = 'smoke'" }],
      pipe_ref: "smoke.echo",
      allow_signatures: true,
    });

    expect(fetchSpy.mock.calls[0]![0]).toBe("http://localhost:8081/v1/build/runner");
    expect(postedBody(fetchSpy)).toEqual({
      files: [{ content: "domain = 'smoke'" }],
      pipe_ref: "smoke.echo",
      allow_signatures: true,
    });
  });
});

describe("build routes — the 200 verdict", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("carries a json inputs template in `inputs`, and echoes the resolved + requested refs", async () => {
    const client = makeClient();
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      jsonResponse(200, {
        is_valid: true,
        pipe_ref: "smoke.echo",
        requested_pipe_ref: "smoke.echo",
        format: "json",
        explicit: false,
        inputs: { text: "text_value" },
        message: "ok",
      }),
    );

    const result = await client.buildInputs({
      files: [{ content: "x" }],
      pipe_ref: "smoke.echo",
    });

    expect(result.is_valid).toBe(true);
    const report = result as BuildInputsValidReport;
    expect(report.inputs).toEqual({ text: "text_value" });
    expect(report.inputs_toml).toBeUndefined();
    expect(report.pipe_ref).toBe("smoke.echo");
  });

  it("carries a toml inputs template as raw text in `inputs_toml`, with `inputs` absent", async () => {
    const client = makeClient();
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      jsonResponse(200, {
        is_valid: true,
        pipe_ref: "smoke.echo",
        format: "toml",
        explicit: false,
        inputs_toml: '# concept: native.Text\ntext = "text_value"\n',
        message: "ok",
      }),
    );

    const result = await client.buildInputs({ files: [{ content: "x" }], format: "toml" });

    const report = result as BuildInputsValidReport;
    // The concept comment is exactly what a parsed-dict shape would have destroyed.
    expect(report.inputs_toml).toContain("# concept: native.Text");
    expect(report.inputs).toBeUndefined();
    // `requested_pipe_ref` is absent because the ref was defaulted to `main_pipe`.
    expect(report.requested_pipe_ref).toBeUndefined();
  });

  it("splits /build/output the same way: an object for schema, source text for python", async () => {
    const client = makeClient();
    vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(
        jsonResponse(200, {
          is_valid: true,
          pipe_ref: "smoke.echo",
          format: "schema",
          output: { concept: "native.Text", content: { type: "object" } },
          message: "ok",
        }),
      )
      .mockResolvedValueOnce(
        jsonResponse(200, {
          is_valid: true,
          pipe_ref: "smoke.echo",
          format: "python",
          output_python: "class TextContent(StuffContent):\n    text: str\n",
          message: "ok",
        }),
      );

    const schema = (await client.buildOutput({
      files: [{ content: "x" }],
      format: "schema",
    })) as BuildOutputValidReport;
    expect(schema.output).toMatchObject({ concept: "native.Text" });
    expect(schema.output_python).toBeUndefined();

    const python = (await client.buildOutput({
      files: [{ content: "x" }],
      format: "python",
    })) as BuildOutputValidReport;
    expect(python.output_python).toContain("class TextContent");
    expect(python.output).toBeUndefined();
  });

  it("carries the stamped structures projection alongside the runner script", async () => {
    const client = makeClient();
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      jsonResponse(200, {
        is_valid: true,
        pipe_ref: "smoke.echo",
        python_code: "import asyncio\n",
        structures: {
          directory: "structures",
          artifacts: [{ path: "structures.py", content: "# >>> pipelex-codegen-stamp >>>\n" }],
          lock: "version = 1\n",
          lock_filename: "codegen.lock",
        },
        message: "ok",
      }),
    );

    const result = (await client.buildRunner({
      files: [{ content: "x" }],
    })) as BuildRunnerValidReport;

    expect(result.python_code).toContain("import asyncio");
    expect(result.structures.artifacts[0]!.path).toBe("structures.py");
    expect(result.structures.lock_filename).toBe("codegen.lock");
  });

  it("returns an unresolvable closure as a 200 is_valid:false verdict, NOT a thrown error", async () => {
    const client = makeClient();
    // A fresh Response per call — a single instance can only have its body read once.
    vi.spyOn(globalThis, "fetch").mockImplementation(async () => jsonResponse(200, INVALID_ARM));

    // Every build route shares the invalid arm; the throw-only consumer is the bug.
    const calls = [
      () => client.buildInputs({ files: [{ content: "x" }] }),
      () => client.buildOutput({ files: [{ content: "x" }] }),
      () => client.buildRunner({ files: [{ content: "x" }] }),
    ];
    for (const call of calls) {
      const result = await call();
      expect(result.is_valid).toBe(false);
      const report = result as CrateInvalidReport;
      expect(report.validation_errors[0]!.message).toBe("boom");
      expect(report.validation_errors[0]!.source).toBe("a.mthds");
    }
  });
});

describe("build routes — the no-verdict arms throw a typed ApiResponseError", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("maps an unresolvable pipe selector to a 422 ApiResponseError", async () => {
    const client = makeClient();
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      problemResponse(422, "Pipe 'smoke.nope' not found in the closure."),
    );

    const failure = client.buildInputs({ files: [{ content: "x" }], pipe_ref: "smoke.nope" });
    await expect(failure).rejects.toBeInstanceOf(ApiResponseError);
    await expect(failure).rejects.toMatchObject({ status: 422 });
  });

  it("maps the reserved method_ref to a 501 ApiResponseError", async () => {
    const client = makeClient();
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      problemResponse(501, "method_ref resolution is not implemented yet."),
    );

    const failure = client.buildRunner({ method_ref: "acme/method@1" });
    await expect(failure).rejects.toBeInstanceOf(ApiResponseError);
    await expect(failure).rejects.toMatchObject({ status: 501 });
  });
});
