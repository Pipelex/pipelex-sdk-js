import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { PipelexApiClient } from "../src/client.js";
import { MissingMainStuffError, RunLifecycleUnavailableError } from "../src/errors.js";

function makeClient(): PipelexApiClient {
  return new PipelexApiClient({ baseUrl: "http://localhost:8081", apiKey: "test-token" });
}

const HOSTED_VERSION = {
  protocol_version: "0.6.0",
  implementation: "pipelex-hosted",
  implementation_version: "0.9.0",
};

const BARE_VERSION = {
  protocol_version: "0.6.0",
  implementation: "pipelex-api",
  implementation_version: "1.2.3",
  runtime_version: "0.32.0",
};

// A spec-compliant runner may report only the protocol's base fields — the
// `implementation` extension is optional. Such a base-only response cannot be
// classified by name; the client must discover the missing lifecycle at runtime.
const BASE_ONLY_VERSION = {
  protocol_version: "0.6.0",
  runner_version: "9.9.9",
};

function jsonResponse(
  status: number,
  body: unknown,
  headers: Record<string, string> = {},
): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...headers },
  });
}

function emptyResponse(status: number, headers: Record<string, string> = {}): Response {
  return new Response(null, { status, headers });
}

// A completed blocking-execute response with a resolvable main stuff: `main_stuff_name`
// names the working-memory root key the SDK resolves into `RunResults.main_stuff`.
function executeBody(runId: string): Record<string, unknown> {
  return {
    pipeline_run_id: runId,
    created_at: "t0",
    state: "COMPLETED",
    main_stuff_name: "result",
    pipe_output: {
      working_memory: {
        root: { result: { concept: "native.Text", content: { text: "hello" } } },
        aliases: { main_stuff: "result" },
      },
      pipeline_run_id: runId,
    },
  };
}

beforeEach(() => {
  vi.restoreAllMocks();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("PipelexApiClient.startAndWaitForResult (hosted — durable start+poll path)", () => {
  it("handshakes /v1/version, starts on /v1/start, then polls to the result", async () => {
    const client = makeClient();
    // version (hosted) → start (202 ack) → results (200). The 202→200
    // polling transition is covered at the client level; here we just prove
    // the client takes the durable path and maps the result.
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(jsonResponse(200, HOSTED_VERSION))
      .mockResolvedValueOnce(
        jsonResponse(202, { pipeline_run_id: "run-1", state: "STARTED", created_at: "t0" }),
      )
      .mockResolvedValueOnce(
        jsonResponse(200, {
          pipeline_run_id: "run-1",
          main_stuff: { answer: 42 },
          graph_spec: { n: 1 },
        }),
      );

    const result = await client.startAndWaitForResult({ pipe_code: "p", mthds_contents: ["x"] });

    expect(result.pipeline_run_id).toBe("run-1");
    expect(result.main_stuff).toEqual({ answer: 42 });
    expect(result.graph_spec).toEqual({ n: 1 });
    // The hosted results body relays no graph assembly error, so the declared field is absent
    // there — documented as "no information", never as "assembly succeeded".
    expect(result.graph_assembly_error).toBeUndefined();

    expect(fetchSpy.mock.calls[0]![0]).toBe("http://localhost:8081/v1/version");
    expect(fetchSpy.mock.calls[1]![0]).toBe("http://localhost:8081/v1/start");
    expect(fetchSpy.mock.calls[2]![0]).toBe("http://localhost:8081/v1/runs/run-1/results");
  });

  it("passes the relayed working memory through as it arrives", async () => {
    const client = makeClient();
    // The `working_memory.json` artifact the platform relays verbatim: every named stuff of the
    // run, inputs included, each carrying its concept as a ref string.
    const workingMemory = {
      root: {
        text: { concept: "native.Text", content: { text: "a long article" } },
        summary: { concept: "my_domain.Summary", content: { title: "Short" } },
      },
      aliases: { main_stuff: "summary" },
    };
    vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(jsonResponse(200, HOSTED_VERSION))
      .mockResolvedValueOnce(
        jsonResponse(202, { pipeline_run_id: "run-1", state: "STARTED", created_at: "t0" }),
      )
      .mockResolvedValueOnce(
        jsonResponse(200, {
          pipeline_run_id: "run-1",
          main_stuff: { title: "Short" },
          working_memory: workingMemory,
          graph_spec: null,
        }),
      );

    const result = await client.startAndWaitForResult({ pipe_code: "p", mthds_contents: ["x"] });

    expect(result.working_memory).toEqual(workingMemory);
    // Typed from the declaration — reached without a cast, the concept a string.
    expect(result.working_memory!.root.text!.concept).toBe("native.Text");
    // The hosted body carries no native output: `working_memory` is the one accessor here.
    expect(result.pipe_output).toBeUndefined();
  });

  it("caches the version handshake across calls", async () => {
    const client = makeClient();
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(jsonResponse(200, HOSTED_VERSION))
      .mockResolvedValueOnce(
        jsonResponse(202, { pipeline_run_id: "r1", state: "STARTED", created_at: "t0" }),
      )
      .mockResolvedValueOnce(jsonResponse(200, { pipeline_run_id: "r1", main_stuff: {} }))
      .mockResolvedValueOnce(
        jsonResponse(202, { pipeline_run_id: "r2", state: "STARTED", created_at: "t1" }),
      )
      .mockResolvedValueOnce(jsonResponse(200, { pipeline_run_id: "r2", main_stuff: {} }));

    await client.startAndWaitForResult({ pipe_code: "p" });
    await client.startAndWaitForResult({ pipe_code: "p" });

    const versionCalls = fetchSpy.mock.calls.filter((call) =>
      String(call[0]).endsWith("/v1/version"),
    );
    expect(versionCalls).toHaveLength(1);
  });

  it("parses the usage pair on the hosted results payload, records verbatim", async () => {
    const client = makeClient();
    const tokensUsages = [
      {
        model_type: "llm",
        inference_model_name: "test-model",
        inference_model_id: "test-model-2026-01-01",
        pipe_code: "test_domain.summarize",
        job_category: "llm_job",
        unit_job_id: "llm_gen_text",
        nb_tokens_by_category: { input: 15, output: 4 },
        cost: 0.000105,
        started_at: "2026-06-20T10:00:01+00:00",
        completed_at: "2026-06-20T10:00:03+00:00",
      },
    ];
    vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(jsonResponse(200, HOSTED_VERSION))
      .mockResolvedValueOnce(
        jsonResponse(202, { pipeline_run_id: "run-1", state: "STARTED", created_at: "t0" }),
      )
      .mockResolvedValueOnce(
        jsonResponse(200, {
          pipeline_run_id: "run-1",
          main_stuff: { answer: 42 },
          tokens_usages: tokensUsages,
          usage_assembly_error: null,
        }),
      );

    const result = await client.startAndWaitForResult({ pipe_code: "p" });

    expect(result.tokens_usages).toEqual(tokensUsages);
    // Read through the typed record — the fields are declared, not index-signature lookups.
    const record = result.tokens_usages![0]!;
    expect(record.inference_model_name).toBe("test-model");
    expect(record.pipe_code).toBe("test_domain.summarize");
    expect(record.nb_tokens_by_category).toEqual({ input: 15, output: 4 });
    expect(record.cost).toBe(0.000105);
    expect(result.usage_assembly_error).toBeNull();
  });

  it("throws MissingMainStuffError on a hosted 200 whose main_stuff is null", async () => {
    const client = makeClient();
    vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(jsonResponse(200, HOSTED_VERSION))
      .mockResolvedValueOnce(
        jsonResponse(202, { pipeline_run_id: "run-1", state: "STARTED", created_at: "t0" }),
      )
      .mockResolvedValueOnce(
        jsonResponse(200, { pipeline_run_id: "run-1", main_stuff: null, graph_spec: { n: 1 } }),
      );

    await expect(client.startAndWaitForResult({ pipe_code: "p" })).rejects.toBeInstanceOf(
      MissingMainStuffError,
    );
  });
});

describe("PipelexApiClient against a bare runner (no run store)", () => {
  it("falls back to blocking POST /v1/execute and resolves the main stuff", async () => {
    const client = makeClient();
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(jsonResponse(200, BARE_VERSION))
      .mockResolvedValueOnce(jsonResponse(200, executeBody("run-x")));

    const result = await client.startAndWaitForResult({ pipe_code: "p", mthds_contents: ["x"] });

    expect(result.pipeline_run_id).toBe("run-x");
    // The SDK resolves `main_stuff` out of the working memory via `main_stuff_name` ("result") —
    // its content, the same shape the hosted path relays; the full working memory rides pipe_output.
    expect(result.main_stuff).toEqual({ text: "hello" });
    // `pipe_output` is the typed `DictPipeOutput` — reached without a cast.
    expect(result.pipe_output!.working_memory.root.result!.content).toEqual({ text: "hello" });
    // No usage pair in the blocking pipe_output (usage off / older runner) → nulls, never a throw.
    expect(result.tokens_usages).toBeNull();
    expect(result.usage_assembly_error).toBeNull();
    // Same for the graph pair: absent from pipe_output means null, not a throw and not undefined.
    expect(result.graph_spec).toBeNull();
    expect(result.graph_assembly_error).toBeNull();
    expect(fetchSpy.mock.calls[0]![0]).toBe("http://localhost:8081/v1/version");
    expect(fetchSpy.mock.calls[1]![0]).toBe("http://localhost:8081/v1/execute");
  });

  it("unpacks the usage pair from the blocking pipe_output", async () => {
    const client = makeClient();
    const tokensUsages = [
      {
        model_type: "llm",
        inference_model_name: "test-model",
        inference_model_id: "test-model-2026-01-01",
        pipe_code: "test_domain.summarize",
        job_category: "llm_job",
        unit_job_id: "llm_gen_text",
        nb_tokens_by_category: { input: 15, output: 4 },
        cost: 0.000105,
        started_at: "2026-06-20T10:00:01+00:00",
        completed_at: "2026-06-20T10:00:03+00:00",
      },
    ];
    const body = executeBody("run-x");
    body["pipe_output"] = {
      ...(body["pipe_output"] as Record<string, unknown>),
      tokens_usages: tokensUsages,
      usage_assembly_error: null,
    };
    vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(jsonResponse(200, BARE_VERSION))
      .mockResolvedValueOnce(jsonResponse(200, body));

    const result = await client.startAndWaitForResult({ pipe_code: "p", mthds_contents: ["x"] });

    // Same accessor and same typed record as the durable path: the pair is lifted out of the
    // extension-open pipe_output.
    expect(result.tokens_usages).toEqual(tokensUsages);
    const record = result.tokens_usages![0]!;
    expect(record.inference_model_name).toBe("test-model");
    expect(record.pipe_code).toBe("test_domain.summarize");
    expect(record.cost).toBe(0.000105);
    expect(result.usage_assembly_error).toBeNull();
  });

  it("lifts the executed graph off the blocking pipe_output", async () => {
    const client = makeClient();
    // The shape the runner returns: the same document a local run writes as `graphspec.json`.
    const graphSpec = {
      meta: { format: "mthds", mode: "live" },
      nodes: [{ id: "pipe_1", status: "COMPLETED" }],
      edges: [],
    };
    const body = executeBody("run-x");
    body["pipe_output"] = {
      ...(body["pipe_output"] as Record<string, unknown>),
      graph_spec: graphSpec,
      graph_assembly_error: null,
    };
    vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(jsonResponse(200, BARE_VERSION))
      .mockResolvedValueOnce(jsonResponse(200, body));

    const result = await client.startAndWaitForResult({ pipe_code: "p", mthds_contents: ["x"] });

    // Regression: this path used to write `graph_spec: null` and drop the graph the runner
    // had already returned, so the field meant different things on the two paths.
    expect(result.graph_spec).toEqual(graphSpec);
    expect(result.graph_assembly_error).toBeNull();
  });

  it("lifts a graph assembly failure off the blocking pipe_output", async () => {
    const client = makeClient();
    const body = executeBody("run-x");
    body["pipe_output"] = {
      ...(body["pipe_output"] as Record<string, unknown>),
      graph_spec: null,
      graph_assembly_error: "failed to assemble the graph for the run",
    };
    vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(jsonResponse(200, BARE_VERSION))
      .mockResolvedValueOnce(jsonResponse(200, body));

    const result = await client.startAndWaitForResult({ pipe_code: "p", mthds_contents: ["x"] });

    // Regression: the error is what separates a broken assembly from a run with no graph —
    // both leave `graph_spec` null.
    expect(result.graph_spec).toBeNull();
    expect(result.graph_assembly_error).toBe("failed to assemble the graph for the run");
  });

  it("lifts the working memory off the blocking pipe_output", async () => {
    const client = makeClient();
    const body = executeBody("run-x");
    const pipeOutput = body["pipe_output"] as Record<string, unknown>;
    // An input beside the main output — the named stuffs `main_stuff` alone does not carry.
    const workingMemory = {
      root: {
        topic: { concept: "native.Text", content: { text: "tides" } },
        result: { concept: "native.Text", content: { text: "hello" } },
      },
      aliases: { main_stuff: "result" },
    };
    body["pipe_output"] = { ...pipeOutput, working_memory: workingMemory };
    vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(jsonResponse(200, BARE_VERSION))
      .mockResolvedValueOnce(jsonResponse(200, body));

    const result = await client.startAndWaitForResult({ pipe_code: "p", mthds_contents: ["x"] });

    // The same accessor as the hosted path, reading the same value the hosted path relays.
    expect(result.working_memory).toEqual(workingMemory);
    expect(result.working_memory!.root.topic!.concept).toBe("native.Text");
    // `pipe_output` stays as it is: the lift reads it, it does not move the value out of it.
    expect(result.pipe_output!.working_memory).toEqual(workingMemory);
    expect(result.main_stuff).toEqual({ text: "hello" });
  });

  it.each([
    ["null", null],
    ["absent", undefined],
  ])(
    "never maps a blocking pipe_output whose working memory is %s — it throws MissingMainStuffError",
    async (_label, workingMemory) => {
      const client = makeClient();
      const body = executeBody("run-x");
      const pipeOutput = { ...(body["pipe_output"] as Record<string, unknown>) };
      if (workingMemory === undefined) {
        delete pipeOutput["working_memory"];
      } else {
        pipeOutput["working_memory"] = workingMemory;
      }
      body["pipe_output"] = pipeOutput;
      vi.spyOn(globalThis, "fetch")
        .mockResolvedValueOnce(jsonResponse(200, BARE_VERSION))
        .mockResolvedValueOnce(jsonResponse(200, body));

      // `main_stuff` is resolved out of the working memory, so a response that carries none can
      // deliver no output: the blocking path never hands back a `RunResults` without the field.
      await expect(
        client.startAndWaitForResult({ pipe_code: "p", mthds_contents: ["x"] }),
      ).rejects.toBeInstanceOf(MissingMainStuffError);
    },
  );

  it("throws MissingMainStuffError when a blocking response names no locatable main stuff", async () => {
    const client = makeClient();
    // `main_stuff_name` points at "answer", but the working-memory root has no such stuff.
    vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(jsonResponse(200, BARE_VERSION))
      .mockResolvedValueOnce(
        jsonResponse(200, {
          pipeline_run_id: "run-y",
          created_at: "t0",
          state: "COMPLETED",
          main_stuff_name: "answer",
          pipe_output: {
            working_memory: {
              root: { other: { concept: "native.Text", content: {} } },
              aliases: {},
            },
            pipeline_run_id: "run-y",
          },
        }),
      );

    await expect(
      client.startAndWaitForResult({ pipe_code: "p", mthds_contents: ["x"] }),
    ).rejects.toBeInstanceOf(MissingMainStuffError);
  });

  it("forwards `extra` extension args through the blocking execute fallback", async () => {
    const client = makeClient();
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(jsonResponse(200, BARE_VERSION))
      .mockResolvedValueOnce(jsonResponse(200, executeBody("run-x")));

    await client.startAndWaitForResult({
      inputs: { a: 1 },
      extra: { some_vendor_selector: "sel_123" },
    });

    expect(fetchSpy.mock.calls[1]![0]).toBe("http://localhost:8081/v1/execute");
    const body = JSON.parse(String((fetchSpy.mock.calls[1]![1] as RequestInit).body));
    // The extension arg rides the request as a top-level field — not dropped.
    expect(body.some_vendor_selector).toBe("sel_123");
  });

  it("forwards a method bundle through the blocking execute fallback", async () => {
    const client = makeClient();
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(jsonResponse(200, BARE_VERSION))
      .mockResolvedValueOnce(jsonResponse(200, executeBody("run-y")));

    const files = { "bundle.mthds": "domain = 'x'", "funcs/f.py": "def f(): ..." };
    await client.startAndWaitForResult({ files });

    expect(fetchSpy.mock.calls[1]![0]).toBe("http://localhost:8081/v1/execute");
    const body = JSON.parse(String((fetchSpy.mock.calls[1]![1] as RequestInit).body));
    // A bare runner reached through the fallback runs the same method as the
    // durable path, or it runs nothing at all.
    expect(body.files).toEqual(files);
  });

  it("forwards a bundle_b64 zip through the blocking execute fallback", async () => {
    const client = makeClient();
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(jsonResponse(200, BARE_VERSION))
      .mockResolvedValueOnce(jsonResponse(200, executeBody("run-z")));

    // The other bundle encoding must survive the fallback too — dropping it here
    // while keeping `files` would otherwise pass unnoticed.
    await client.startAndWaitForResult({ bundle_b64: "UEsDBA==" });

    expect(fetchSpy.mock.calls[1]![0]).toBe("http://localhost:8081/v1/execute");
    const body = JSON.parse(String((fetchSpy.mock.calls[1]![1] as RequestInit).body));
    expect(body.bundle_b64).toBe("UEsDBA==");
  });

  it("self-heals when a base-only version response hides a missing run store", async () => {
    const client = makeClient();
    // version omits `implementation` → looks hosted → tries /v1/start, which a
    // bare runner 404s (no run created) → falls back to the blocking /v1/execute.
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(jsonResponse(200, BASE_ONLY_VERSION))
      .mockResolvedValueOnce(jsonResponse(404, { detail: "Not Found" }))
      .mockResolvedValueOnce(jsonResponse(200, executeBody("run-z")))
      // A second call must skip the durable attempt entirely (negative cached).
      .mockResolvedValueOnce(jsonResponse(200, executeBody("run-z2")));

    const result = await client.startAndWaitForResult({ pipe_code: "p" });
    expect(result.pipeline_run_id).toBe("run-z");
    expect(fetchSpy.mock.calls.map((c) => String(c[0]))).toEqual([
      "http://localhost:8081/v1/version",
      "http://localhost:8081/v1/start",
      "http://localhost:8081/v1/execute",
    ]);

    await client.startAndWaitForResult({ pipe_code: "p" });
    // Second call: no version re-handshake, no start retry — straight to execute.
    expect(fetchSpy.mock.calls[3]![0]).toBe("http://localhost:8081/v1/execute");
    expect(fetchSpy.mock.calls).toHaveLength(4);
  });

  it("the run-lifecycle primitives surface RunLifecycleUnavailableError on the bare 404", async () => {
    const client = makeClient();
    // Bare runner: Starlette's default 404 body — no structured `code` field.
    // A fresh Response per call: a body is single-read, so a shared instance
    // would come back empty on the second request.
    vi.spyOn(globalThis, "fetch").mockImplementation(() =>
      Promise.resolve(jsonResponse(404, { detail: "Not Found" })),
    );

    await expect(client.getRunStatus("r")).rejects.toBeInstanceOf(RunLifecycleUnavailableError);
    await expect(client.getRunResult("r")).rejects.toBeInstanceOf(RunLifecycleUnavailableError);
    await expect(client.waitForResult("r")).rejects.toBeInstanceOf(RunLifecycleUnavailableError);
  });

  it("health resolves to the origin root, not under the /v1 prefix", async () => {
    const client = makeClient();
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(jsonResponse(200, { status: "ok" }));

    await client.health();
    expect(fetchSpy.mock.calls[0]![0]).toBe("http://localhost:8081/health");
    expect(fetchSpy.mock.calls[0]![0]).not.toBe("http://localhost:8081/v1/health");
  });
});

describe("PipelexApiClient run-lifecycle delegation", () => {
  it("start returns the RunResult ack", async () => {
    const client = makeClient();
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      jsonResponse(202, { pipeline_run_id: "run-9", state: "STARTED", created_at: "t0" }),
    );
    const ack = await client.start({ pipe_code: "p", mthds_contents: ["x"] });
    expect(ack.pipeline_run_id).toBe("run-9");
    expect(ack.state).toBe("STARTED"); // server extension field, preserved via the index signature
  });

  it("getRunResult reports a still-running run as running", async () => {
    const client = makeClient();
    vi.spyOn(globalThis, "fetch").mockResolvedValue(emptyResponse(202, { "Retry-After": "3" }));
    const state = await client.getRunResult("run-9");
    expect(state.state).toBe("running");
  });

  it("version delegates to GET /v1/version", async () => {
    const client = makeClient();
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(jsonResponse(200, BARE_VERSION));
    const info = await client.version();
    expect(info.implementation).toBe("pipelex-api");
    expect(fetchSpy.mock.calls[0]![0]).toBe("http://localhost:8081/v1/version");
  });

  it("validate delegates to POST /v1/validate", async () => {
    const client = makeClient();
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(jsonResponse(200, { is_valid: true, bundle_blueprint: {} }));
    await client.validate(["domain = 'x'"]);
    expect(fetchSpy.mock.calls[0]![0]).toBe("http://localhost:8081/v1/validate");
  });

  it("build helpers hit /v1/build/*", async () => {
    const client = makeClient();
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockImplementation(async () => jsonResponse(200, {}));
    await client.buildInputs({ files: [{ content: "x" }] });
    await client.concept({ spec: {} });
    await client.pipeSpec({ pipe_type: "PipeLLM", spec: {} });
    expect(fetchSpy.mock.calls[0]![0]).toBe("http://localhost:8081/v1/build/inputs");
    expect(fetchSpy.mock.calls[1]![0]).toBe("http://localhost:8081/v1/build/concept");
    expect(fetchSpy.mock.calls[2]![0]).toBe("http://localhost:8081/v1/build/pipe-spec");
  });
});
