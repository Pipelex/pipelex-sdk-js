/**
 * The pipe I/O route — `POST /v1/pipe-io`, the crate-route family's third member.
 *
 * The same three things `crate-routes.test.ts` pins for `resolve` and `codegen`, since a
 * consumer gets them wrong the same way:
 *
 * 1. **The request type IS the wire body.** The envelope is posted verbatim — the closure
 *    selector, the pipe selector and the two opt-ins, each ABSENT (not `undefined`) when
 *    unset, and the selector XOR left to the server.
 * 2. **The 200 is a verdict, not a payload.** An unresolvable closure is a 200
 *    `is_valid: false`; only a no-verdict condition (a selection or request-shape 422,
 *    the reserved registry-form `method_ref` 501) throws the typed `ApiResponseError`.
 * 3. **The valid arm is relayed untouched.** The three artifacts are the standard's, and
 *    `/v1/validate`'s maps are pinned to them byte for byte, null members included — the
 *    client must not reshape or drop anything on the way out.
 */

import { describe, it, expect, vi, afterEach } from "vitest";
import { PipelexApiClient } from "../src/client.js";
import { ApiResponseError, ApiUnreachableError } from "../src/errors.js";
import type { CrateInvalidReport, PipeIOValidReport } from "../src/models.js";

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
function problemResponse(status: number, detail: string, errorType?: string): Response {
  const body: Record<string, unknown> = { status, title: "Error", detail };
  if (errorType !== undefined) body.error_type = errorType;
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/problem+json" },
  });
}

function postedBody(spy: ReturnType<typeof vi.spyOn>): unknown {
  const init = spy.mock.calls[0]![1] as RequestInit;
  return JSON.parse(init.body as string);
}

/** A valid arm for one pipe, as the runner emits it — null members and all. */
const VALID_ARM: PipeIOValidReport = {
  is_valid: true,
  pipe_ref: "smoke.echo",
  pipe_io_contracts: {
    "smoke.echo": {
      inputs: {
        text: {
          concept_ref: "native.Text",
          json_schema: { type: "string" },
          presence: "plain",
          multiplicity: "single",
          item_count: null,
        },
      },
      output: {
        concept_ref: "native.Text",
        multiplicity: "single",
        item_count: null,
        optional: false,
        json_schema: { type: "string" },
      },
    },
  },
  input_form: {
    "smoke.echo": {
      fields: [
        {
          name: "text",
          kind: "prose",
          concept_ref: "native.Text",
          required: true,
          presence: "plain",
          gating: true,
        },
      ],
    },
  },
  output_form: {
    "smoke.echo": {
      field: { name: "output", kind: "prose", concept_ref: "native.Text", required: true },
    },
  },
  default_pipe_ref: "smoke.echo",
  pending_signatures: [],
  is_runnable: true,
};

const INVALID_ARM: CrateInvalidReport = {
  is_valid: false,
  validation_errors: [{ category: "blueprint_validation", message: "boom", source: "smoke.mthds" }],
  message: "MTHDS library could not be resolved",
};

describe("pipeIo — request envelope", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("posts the files[] envelope to /v1/pipe-io, with no selector or opt-in key it was not given", async () => {
    const client = makeClient();
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(jsonResponse(200, VALID_ARM));

    await client.pipeIo({
      files: [{ content: "domain = 'smoke'", source: "smoke.mthds" }, { content: "domain = 'b'" }],
    });

    expect(fetchSpy.mock.calls[0]![0]).toBe("http://localhost:8081/v1/pipe-io");
    // Not `pipe_ref: undefined`, `all_pipes: false`: every unset key is absent, so the
    // server's own defaults decide.
    expect(postedBody(fetchSpy)).toEqual({
      files: [{ content: "domain = 'smoke'", source: "smoke.mthds" }, { content: "domain = 'b'" }],
    });
  });

  it("posts the pipe selector and both opt-ins verbatim", async () => {
    const client = makeClient();
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(jsonResponse(200, VALID_ARM));

    await client.pipeIo({
      files: [{ content: "domain = 'smoke'" }],
      pipe_ref: "smoke.echo",
      all_pipes: true,
      include_files: true,
    });

    expect(postedBody(fetchSpy)).toEqual({
      files: [{ content: "domain = 'smoke'" }],
      pipe_ref: "smoke.echo",
      all_pipes: true,
      include_files: true,
    });
  });

  it("posts a method_ref-only and a method_id-only envelope untouched", async () => {
    const client = makeClient();
    // Nothing is expanded client-side: the runner fetches the address, and the platform
    // resolves the id and forwards the stored files before the runner sees the request.
    const onRef = vi.spyOn(globalThis, "fetch").mockResolvedValue(jsonResponse(200, VALID_ARM));
    await client.pipeIo({ method_ref: "github.com/Pipelex/methods/documents@v0.1.0" });
    expect(postedBody(onRef)).toEqual({
      method_ref: "github.com/Pipelex/methods/documents@v0.1.0",
    });

    vi.restoreAllMocks();
    const onId = vi.spyOn(globalThis, "fetch").mockResolvedValue(jsonResponse(200, VALID_ARM));
    await client.pipeIo({ method_id: "mt_1", pipe_ref: "smoke.echo" });
    expect(postedBody(onId)).toEqual({ method_id: "mt_1", pipe_ref: "smoke.echo" });
  });

  it("leaves the selector XOR to the server — two selectors reach the wire and come back a 422", async () => {
    const client = makeClient();
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(
        problemResponse(422, "provide exactly one of `files` or `method_ref`", "ValidationError"),
      );

    const failure = client.pipeIo({ files: [{ content: "x" }], method_ref: "github.com/o/r" });

    await expect(failure).rejects.toBeInstanceOf(ApiResponseError);
    await expect(failure).rejects.toMatchObject({ status: 422, errorType: "ValidationError" });
    expect(postedBody(fetchSpy)).toEqual({
      files: [{ content: "x" }],
      method_ref: "github.com/o/r",
    });
  });
});

describe("pipeIo — a method_ref closure gets the fetch budget", () => {
  /** A fetch that never resolves; it only rejects when its abort signal fires. */
  function hangingFetch(): typeof fetch {
    return ((_url: string, init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(init.signal?.reason), {
          once: true,
        });
      })) as typeof fetch;
  }

  /** Observe settlement without awaiting — we need to assert "still pending". */
  function track<T>(promise: Promise<T>): { settled: boolean; error: unknown } {
    const state: { settled: boolean; error: unknown } = { settled: false, error: undefined };
    promise.then(
      () => {
        state.settled = true;
      },
      (error: unknown) => {
        state.settled = true;
        state.error = error;
      },
    );
    return state;
  }

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("lets a files-form call time out at 30s while a method_ref call keeps waiting", async () => {
    vi.useFakeTimers();
    vi.spyOn(globalThis, "fetch").mockImplementation(hangingFetch());
    const client = makeClient();

    const byFiles = track(client.pipeIo({ files: [{ content: "domain = 'smoke'\n" }] }));
    const byId = track(client.pipeIo({ method_id: "mt_1" }));
    const byRef = track(client.pipeIo({ method_ref: "github.com/Pipelex/methods/documents" }));

    await vi.advanceTimersByTimeAsync(31_000);
    expect(byFiles.settled).toBe(true);
    expect(byFiles.error).toBeInstanceOf(ApiUnreachableError);
    // A catalog id is resolved by the platform from its own store: no clone, no budget.
    expect(byId.settled).toBe(true);
    expect(byRef.settled).toBe(false);

    await vi.advanceTimersByTimeAsync(180_000);
    expect(byRef.settled).toBe(true);
    expect(byRef.error).toBeInstanceOf(ApiUnreachableError);
  });
});

describe("pipeIo — the 200 verdict", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("relays the valid arm untouched, the contracts' null item_count included", async () => {
    const client = makeClient();
    vi.spyOn(globalThis, "fetch").mockResolvedValue(jsonResponse(200, VALID_ARM));

    const result = await client.pipeIo({ files: [{ content: "domain = 'smoke'" }] });

    expect(result).toEqual(VALID_ARM);
    expect(result.is_valid).toBe(true);
    const report = result as PipeIOValidReport;
    expect(report.pipe_io_contracts["smoke.echo"]!.inputs.text!.item_count).toBeNull();
    // Absent, not empty, without `include_files`.
    expect("files" in report).toBe(false);
  });

  it("relays the files echo and a null pipe_ref under all_pipes", async () => {
    const client = makeClient();
    const echoed = [{ content: "domain = 'smoke'", source: "smoke.mthds" }];
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      jsonResponse(200, { ...VALID_ARM, pipe_ref: null, default_pipe_ref: null, files: echoed }),
    );

    const result = await client.pipeIo({
      files: echoed,
      all_pipes: true,
      include_files: true,
    });

    const report = result as PipeIOValidReport;
    expect(report.pipe_ref).toBeNull();
    expect(report.default_pipe_ref).toBeNull();
    expect(report.files).toEqual(echoed);
  });

  it("returns the shared invalid arm as a value — never a throw", async () => {
    const client = makeClient();
    vi.spyOn(globalThis, "fetch").mockResolvedValue(jsonResponse(200, INVALID_ARM));

    const result = await client.pipeIo({ files: [{ content: "!!broken" }], include_files: true });

    expect(result.is_valid).toBe(false);
    const report = result as CrateInvalidReport;
    expect(report.validation_errors[0]!.message).toBe("boom");
    expect(report.validation_errors[0]!.source).toBe("smoke.mthds");
  });
});

describe("pipeIo — what throws", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("throws ApiResponseError on a selection refusal, its error_type intact", async () => {
    const client = makeClient();
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      problemResponse(422, "Pipe 'smoke.absent' not found", "EntryPipeNotFoundError"),
    );

    // The client relays; turning a selection refusal into a preparation error is
    // `prepareInputs`' decision, not the route method's.
    const failure = client.pipeIo({ files: [{ content: "x" }], pipe_ref: "smoke.absent" });
    await expect(failure).rejects.toBeInstanceOf(ApiResponseError);
    await expect(failure).rejects.toMatchObject({
      status: 422,
      errorType: "EntryPipeNotFoundError",
      serverMessage: "Pipe 'smoke.absent' not found",
    });
  });

  it("maps the reserved registry-form method_ref to a 501 and an unknown id to a 404", async () => {
    const client = makeClient();
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      problemResponse(501, "Registry-form method_ref resolution is not implemented yet."),
    );
    await expect(client.pipeIo({ method_ref: "acme/method@1" })).rejects.toMatchObject({
      status: 501,
    });

    vi.restoreAllMocks();
    vi.spyOn(globalThis, "fetch").mockResolvedValue(problemResponse(404, "No such method."));
    await expect(client.pipeIo({ method_id: "mt_missing" })).rejects.toMatchObject({
      status: 404,
    });
  });
});
