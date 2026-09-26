/**
 * A failed run's stored report and a problem document's members, carried whole.
 *
 * The bodies under `fixtures/problems/` are recorded, not hand-written:
 *
 * - `results-409-failed.json` and `results-409-cancelled.json` are what the platform's own error
 *   handler rendered for `RunFinishedWithoutResultError` (pipelex-server's `platform` package,
 *   run in-process through a FastAPI `TestClient`), the first carrying a runner's VERBOSE
 *   `ErrorReport` as it reads back from the run store — which is why its
 *   `provider_metadata.status_code` and `retry_after_seconds` are strings.
 * - `runner-500-model-unavailable.json` is `pipelex`'s `ErrorReport.to_problem_document` for an
 *   inference failure, the body a runner answers `/v1/execute` with.
 * - `platform-422-field-errors.json` is the platform's request-validation `422`, with `errors[]`.
 */

import { readFileSync } from "node:fs";

import { afterEach, beforeEach, describe, expect, expectTypeOf, it, vi } from "vitest";
import type {
  ProblemDetails as MthdsProblemDetails,
  UserAction as MthdsUserAction,
} from "mthds/errors";

import { PipelexApiClient } from "../src/client.js";
import type { ProblemDetails, RunErrorReport, UserAction } from "../src/error-models.js";
import { ApiResponseError, RunFailedError } from "../src/errors.js";
import type { RunRead, RunResultState } from "../src/runs.js";

const BASE_URL = "http://localhost:8081";
const FIXTURES = new URL("./fixtures/problems/", import.meta.url);

function fixture(name: string): Record<string, unknown> {
  return JSON.parse(readFileSync(new URL(name, FIXTURES), "utf8")) as Record<string, unknown>;
}

const FAILED_409 = fixture("results-409-failed.json");
const CANCELLED_409 = fixture("results-409-cancelled.json");
const RUNNER_500 = fixture("runner-500-model-unavailable.json");
const PLATFORM_422 = fixture("platform-422-field-errors.json");

const HOSTED_VERSION = {
  protocol_version: "0.6.0",
  implementation: "pipelex-hosted",
  implementation_version: "0.9.0",
};

function makeClient(): PipelexApiClient {
  return new PipelexApiClient({ baseUrl: BASE_URL, apiKey: "test-token" });
}

function problemResponse(
  status: number,
  body: unknown,
  headers: Record<string, string> = {},
): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/problem+json", ...headers },
  });
}

function emptyResponse(status: number, headers: Record<string, string> = {}): Response {
  return new Response(null, { status, headers });
}

async function caught(promise: Promise<unknown>): Promise<unknown> {
  return promise.then(
    () => expect.fail("expected the call to throw"),
    (err: unknown) => err,
  );
}

beforeEach(() => {
  vi.restoreAllMocks();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("the results read's 409 — a failed run's report", () => {
  it("yields a failed arm carrying the whole report, typed, and the status from the body", async () => {
    const client = makeClient();
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      problemResponse(409, FAILED_409, { "X-Request-ID": "2b33a25e1a8347229404aaeec813f915" }),
    );

    const state = await client.getRunResult("run-1");

    expect(state.state).toBe("failed");
    if (state.state !== "failed") return;
    expect(state.pipeline_run_id).toBe("run-1");
    expect(state.status).toBe("FAILED");
    expect(state.message).toBe(FAILED_409.detail);
    // Every field of the stored report, exactly as the platform served it.
    expect(state.error).toEqual(FAILED_409.error);
    expect(state.error?.error_domain).toBe("config");
    expect(state.error?.retryable).toBe(false);
    expect(state.error?.user_action).toEqual({
      kind: "change_model",
      detail: "Choose a model the gateway serves, e.g. one listed by `pipelex-agent models`.",
    });
    expect(state.error?.type_uri).toBe("https://pipelex.com/errors/pipe-run-error");
    expect(state.error?.provider_metadata?.status_code).toBe("404");
    expectTypeOf<
      Extract<RunResultState, { state: "failed" }>["error"]
    >().toEqualTypeOf<RunErrorReport | null>();
  });

  it("yields a report-less failure with the run's own status when `error` is null", async () => {
    const client = makeClient();
    vi.spyOn(globalThis, "fetch").mockResolvedValue(problemResponse(409, CANCELLED_409));

    const state = await client.getRunResult("run-1");

    expect(state).toEqual({
      state: "failed",
      pipeline_run_id: "run-1",
      status: "CANCELLED",
      message: "Run finished with status CANCELLED; no result available",
      error: null,
    });
  });

  it("reads the status from `run_status`, never from the sentence", async () => {
    const client = makeClient();
    vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(
        problemResponse(409, {
          ...CANCELLED_409,
          detail: "Run finished with status FAILED; no result available",
          run_status: "TIMED_OUT",
        }),
      )
      // A 409 with no `run_status` (a stored result the route refuses to read) reads as FAILED,
      // whatever word its sentence happens to hold.
      .mockResolvedValueOnce(
        problemResponse(409, {
          type: "https://pipelex.com/errors/conflict",
          code: "conflict",
          detail: "Run finished with status TERMINATED; no result available",
        }),
      );

    const fromMember = await client.getRunResult("run-1");
    const withoutMember = await client.getRunResult("run-2");

    expect(fromMember).toMatchObject({ state: "failed", status: "TIMED_OUT", error: null });
    expect(withoutMember).toMatchObject({ state: "failed", status: "FAILED", error: null });
  });

  it("reads an unknown status or a non-object report as absent", async () => {
    const client = makeClient();
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      problemResponse(409, { ...FAILED_409, run_status: "EXPLODED", error: "not a report" }),
    );

    const state = await client.getRunResult("run-1");

    expect(state).toMatchObject({ state: "failed", status: "FAILED", error: null });
  });

  it("makes waitForResult throw a RunFailedError carrying the whole report", async () => {
    const client = makeClient();
    vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(emptyResponse(202, { "Retry-After": "0" }))
      .mockResolvedValueOnce(problemResponse(409, FAILED_409));

    const err = await caught(client.waitForResult("run-1", { intervalMs: 0 }));

    expect(err).toBeInstanceOf(RunFailedError);
    const failure = err as RunFailedError;
    expect(failure.runId).toBe("run-1");
    expect(failure.status).toBe("FAILED");
    expect(failure.message).toBe(FAILED_409.detail);
    expect(failure.error).toEqual(FAILED_409.error);
    expectTypeOf(failure.error).toEqualTypeOf<RunErrorReport | null>();
  });

  it("makes waitForResult throw a report-less RunFailedError when `error` is null", async () => {
    const client = makeClient();
    vi.spyOn(globalThis, "fetch").mockResolvedValue(problemResponse(409, CANCELLED_409));

    const err = await caught(client.waitForResult("run-1", { intervalMs: 0 }));

    expect(err).toBeInstanceOf(RunFailedError);
    expect((err as RunFailedError).status).toBe("CANCELLED");
    expect((err as RunFailedError).error).toBeNull();
  });

  it("makes startAndWaitForResult throw the report of the run it started", async () => {
    const client = makeClient();
    vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(problemResponse(200, HOSTED_VERSION))
      .mockResolvedValueOnce(
        problemResponse(202, { pipeline_run_id: "run-9", state: "STARTED", created_at: "t0" }),
      )
      .mockResolvedValueOnce(problemResponse(409, FAILED_409));

    const err = await caught(
      client.startAndWaitForResult({ pipe_code: "p", mthds_contents: ["x"] }, { intervalMs: 0 }),
    );

    expect(err).toBeInstanceOf(RunFailedError);
    expect((err as RunFailedError).runId).toBe("run-9");
    expect((err as RunFailedError).error).toEqual(FAILED_409.error);
  });
});

describe("the status read — `RunRead.error`", () => {
  it("exposes the stored report typed on the run", async () => {
    const client = makeClient();
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      problemResponse(200, {
        pipeline_run_id: "run-1",
        status: "FAILED",
        created_at: "2026-09-26T10:00:00+00:00",
        finished_at: "2026-09-26T10:01:00+00:00",
        degraded: false,
        error: FAILED_409.error,
      }),
    );

    const run = await client.getRunStatus("run-1");

    expect(run.error).toEqual(FAILED_409.error);
    expect(run.error?.message).toContain("Pipe 'summarize'");
    expectTypeOf<RunRead["error"]>().toEqualTypeOf<RunErrorReport | null | undefined>();
  });
});

describe("ApiResponseError — the problem document's members", () => {
  it("exposes each member a platform problem carries, `errors[]` included", async () => {
    const client = makeClient();
    vi.spyOn(globalThis, "fetch").mockResolvedValue(problemResponse(422, PLATFORM_422));

    const err = await caught(client.createPipelexApiKey({ label: "" }));

    expect(err).toBeInstanceOf(ApiResponseError);
    const e = err as ApiResponseError;
    expect(e.status).toBe(422);
    expect(e.code).toBe("validation_failed");
    expect(e.type).toBe("https://pipelex.com/errors/validation_failed");
    expect(e.title).toBe("Validation failed");
    expect(e.instance).toBe("urn:pipelex:request:a9a249b93c024bf08ac9a5fd0704ea92");
    expect(e.requestId).toBe("a9a249b93c024bf08ac9a5fd0704ea92");
    expect(e.serverMessage).toBe(PLATFORM_422.detail);
    expect(e.errors).toEqual([
      {
        field: "label",
        code: "string_too_short",
        detail: "String should have at least 1 character",
      },
    ]);
    // The platform does not classify its own refusals yet.
    expect(e.errorDomain).toBeUndefined();
    expect(e.retryable).toBeUndefined();
    expect(e.problemDocument).toEqual(PLATFORM_422);
  });

  it("exposes each member a runner's problem carries", async () => {
    const client = makeClient();
    vi.spyOn(globalThis, "fetch").mockResolvedValue(problemResponse(500, RUNNER_500));

    const err = await caught(client.execute({ pipe_code: "p", mthds_contents: ["x"] }));

    expect(err).toBeInstanceOf(ApiResponseError);
    const e = err as ApiResponseError;
    expect(e.type).toBe("https://docs.pipelex.com/latest/errors/llm-completion-error/");
    expect(e.title).toBe("LLM completion");
    expect(e.instance).toBe("/v1/execute");
    expect(e.requestId).toBe("9f2c1ab3-5d1e-4c2a-9a41-0c7f3e2b8d10");
    expect(e.errorType).toBe("LLMCompletionError");
    expect(e.errorDomain).toBe("config");
    expect(e.errorCategory).toBe("configuration");
    expect(e.retryable).toBe(false);
    expect(e.userAction).toEqual({
      kind: "change_model",
      detail: "Pick a model your backend serves; `pipelex-agent models` lists them.",
    });
    expect(e.model).toBe("gpt-6-astra");
    expect(e.provider).toBe("openai");
    expect(e.providerMetadata).toEqual(RUNNER_500.provider_metadata);
    expect(e.code).toBeUndefined();
    expect(e.errors).toBeUndefined();
    // A member this SDK does not name stays reachable on the decoded document.
    expect(e.problemDocument?.status).toBe(500);
  });

  it("reads the request id from the X-Request-ID header when the body carries none", async () => {
    const client = makeClient();
    vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(
        new Response("<html>Bad Gateway</html>", {
          status: 502,
          statusText: "Bad Gateway",
          headers: { "X-Request-ID": " gw-7f3a " },
        }),
      )
      .mockResolvedValueOnce(
        problemResponse(500, RUNNER_500, { "X-Request-ID": "from-the-header" }),
      );

    const headerOnly = (await caught(client.getMe())) as ApiResponseError;
    const both = (await caught(client.getMe())) as ApiResponseError;

    expect(headerOnly.requestId).toBe("gw-7f3a");
    expect(headerOnly.problemDocument).toBeUndefined();
    // The body's own id wins over the header's.
    expect(both.requestId).toBe(RUNNER_500.request_id);
  });

  it("reads a member of the wrong type as absent, and still yields the message", async () => {
    const client = makeClient();
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      problemResponse(422, {
        type: 42,
        title: "",
        detail: "Input 'document' is missing.",
        request_id: ["r"],
        error_domain: "",
        error_category: 3,
        retryable: "no",
        user_action: { kind: "change_input" },
        model: null,
        provider_metadata: ["openai"],
        migration: "stale",
        errors: [{ field: "document", code: "missing" }, "not an item", null],
      }),
    );

    const e = (await caught(client.getMe())) as ApiResponseError;

    expect(e.serverMessage).toBe("Input 'document' is missing.");
    expect(e.type).toBeUndefined();
    expect(e.title).toBeUndefined();
    expect(e.requestId).toBeUndefined();
    expect(e.errorDomain).toBeUndefined();
    expect(e.errorCategory).toBeUndefined();
    expect(e.retryable).toBeUndefined();
    expect(e.userAction).toBeUndefined();
    expect(e.model).toBeUndefined();
    expect(e.providerMetadata).toBeUndefined();
    expect(e.migration).toBeUndefined();
    expect(e.errors).toEqual([{ field: "document", code: "missing" }]);
  });

  it("keeps the problem members when constructed directly", () => {
    const e = new ApiResponseError(
      "boom",
      BASE_URL,
      409,
      "Conflict",
      "{}",
      undefined,
      "boom",
      undefined,
      "conflict",
      {
        cause: new Error("root"),
        problem: { type: "https://pipelex.com/errors/conflict", requestId: "r-1", retryable: true },
        problemDocument: { code: "conflict" },
      },
    );

    expect(e.type).toBe("https://pipelex.com/errors/conflict");
    expect(e.requestId).toBe("r-1");
    expect(e.retryable).toBe(true);
    expect(e.problemDocument).toEqual({ code: "conflict" });
    expect((e.cause as Error).message).toBe("root");
  });
});

describe("the vocabulary is the standard client's", () => {
  it("declares the problem members under mthds's names and types", () => {
    // `@pipelex/sdk` depends on `mthds` only through `mthds/protocol`, so these are declared
    // here rather than imported; this pins them to the standard client's declarations, so a
    // consumer reads one vocabulary whichever client raised the error.
    expectTypeOf<UserAction>().toEqualTypeOf<MthdsUserAction>();
    expectTypeOf<ProblemDetails>().toExtend<MthdsProblemDetails>();
    expectTypeOf<
      Pick<ProblemDetails, keyof MthdsProblemDetails>
    >().toEqualTypeOf<MthdsProblemDetails>();
  });
});
