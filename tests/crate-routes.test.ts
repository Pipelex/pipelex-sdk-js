/**
 * The crate routes — `POST /v1/resolve` and `POST /v1/codegen`.
 *
 * Three things are pinned here, and they are the three a consumer gets wrong:
 *
 * 1. **The request type IS the wire body.** Crate requests are posted verbatim, so
 *    these tests assert the exact JSON that leaves the client — the `files[]` XOR
 *    `method_ref` envelope, and codegen's two explicit `kind`/`target` axes with
 *    `pipe_ref` ABSENT (not `undefined`) when unset.
 * 2. **The 200 is a verdict, not a payload.** An unresolvable closure comes back as a
 *    200 `is_valid: false`, so a consumer that only catches throws would render a
 *    success over an unusable result. Only a no-verdict condition (a request-shape
 *    422, the reserved registry-form `method_ref` 501) throws the typed
 *    `ApiResponseError`.
 * 3. **The valid arms are relayed untouched.** The crate object and the codegen
 *    artifacts + lock are the whole point of the routes: the client must not reshape,
 *    re-serialize, or drop fields on the way out, or the codegen trust chain (write
 *    verbatim ⇒ offline `codegen check` passes) breaks silently.
 */

import { describe, it, expect, vi, afterEach } from "vitest";
import { PipelexApiClient } from "../src/client.js";
import { ApiResponseError, ApiUnreachableError } from "../src/errors.js";
import type { CodegenValidReport, CrateInvalidReport, ResolveValidReport } from "../src/models.js";

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
  validation_errors: [{ category: "blueprint_validation", message: "boom", source: "smoke.mthds" }],
  message: "MTHDS library could not be resolved",
};

describe("crate routes — request envelope", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("posts the files[] envelope to /v1/resolve with per-file source labels", async () => {
    const client = makeClient();
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(jsonResponse(200, { is_valid: true, crate: {}, message: "ok" }));

    await client.resolve({
      files: [
        { content: "domain = 'smoke'", source: "smoke.mthds" },
        { content: "domain = 'other'" },
      ],
    });

    expect(fetchSpy.mock.calls[0]![0]).toBe("http://localhost:8081/v1/resolve");
    expect(postedBody(fetchSpy)).toEqual({
      files: [
        { content: "domain = 'smoke'", source: "smoke.mthds" },
        { content: "domain = 'other'" },
      ],
    });
  });

  it("posts codegen's two explicit axes beside the closure, and omits pipe_ref entirely when unset", async () => {
    const client = makeClient();
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(jsonResponse(200, { is_valid: true }));

    await client.codegen({
      files: [{ content: "domain = 'smoke'" }],
      kind: "types",
      target: "ts-zod",
    });

    expect(fetchSpy.mock.calls[0]![0]).toBe("http://localhost:8081/v1/codegen");
    // Not `pipe_ref: undefined` — the key must be absent. `kind: "types"` REJECTS a
    // pipe_ref with a 422, so emitting the key at all would turn every default call
    // into a request-shape error.
    expect(postedBody(fetchSpy)).toEqual({
      files: [{ content: "domain = 'smoke'" }],
      kind: "types",
      target: "ts-zod",
    });
  });

  it("posts a method_ref-only envelope untouched (the server owns the selector XOR)", async () => {
    const client = makeClient();
    // An address-form ref is resolved server-side (pipelex-api >= 0.21.0): fetch at
    // tag, package located by manifest identity, real file paths as per-file sources.
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(jsonResponse(200, { is_valid: true, crate: {}, message: "ok" }));

    await client.resolve({ method_ref: "github.com/Pipelex/methods/documents@v0.1.0" });

    // No `files` key alongside it: the envelope carries exactly one selector.
    expect(postedBody(fetchSpy)).toEqual({
      method_ref: "github.com/Pipelex/methods/documents@v0.1.0",
    });
  });

  it("maps the reserved registry-form method_ref to a 501 ApiResponseError", async () => {
    const client = makeClient();
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      problemResponse(501, "Registry-form method_ref resolution is not implemented yet."),
    );

    // Only the ADDRESS form is un-reserved; any non-address reference keeps the 501.
    const failure = client.resolve({ method_ref: "acme/method@1" });
    await expect(failure).rejects.toBeInstanceOf(ApiResponseError);
    await expect(failure).rejects.toMatchObject({ status: 501 });
  });

  it("posts a method_id-only envelope untouched — by-id is a hosted pass-through, on both routes", async () => {
    const client = makeClient();
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(jsonResponse(200, { is_valid: true, crate: {}, message: "ok" }));

    // Nothing is expanded client-side: the platform resolves the id and injects the
    // stored source before the runner sees the request.
    await client.resolve({ method_id: "mt_1" });
    expect(postedBody(fetchSpy)).toEqual({ method_id: "mt_1" });

    vi.restoreAllMocks();
    const onCodegen = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(jsonResponse(200, { is_valid: true }));
    await client.codegen({ method_id: "mt_1", kind: "types", target: "ts-zod" });
    expect(postedBody(onCodegen)).toEqual({ method_id: "mt_1", kind: "types", target: "ts-zod" });
  });

  it("surfaces the hosted selector no-verdict arms as typed ApiResponseErrors (404 unknown id, 422 XOR)", async () => {
    const client = makeClient();
    // Unknown and foreign-org ids are both 404 (indistinguishable by design).
    vi.spyOn(globalThis, "fetch").mockResolvedValue(problemResponse(404, "No such method."));
    const notFound = client.resolve({ method_id: "mt_missing" });
    await expect(notFound).rejects.toBeInstanceOf(ApiResponseError);
    await expect(notFound).rejects.toMatchObject({ status: 404 });

    vi.restoreAllMocks();
    // A second selector beside the id is the strict tooling XOR's 422 — the server
    // owns the check (the request type already forbids `files` + `method_id` only
    // pairwise through docs, not `never` pins, matching the files/method_ref posture).
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      problemResponse(422, "provide exactly one of `files`, `method_ref`, or `method_id`"),
    );
    const overSpecified = client.resolve({ files: [{ content: "x" }], method_id: "mt_1" });
    await expect(overSpecified).rejects.toMatchObject({ status: 422 });
  });
});

describe("crate routes — a method_ref closure gets the fetch budget", () => {
  // A `method_ref` closure can make the server CLONE a repository before it
  // answers, and the server-side clone timeout runs well past the 30s
  // static-route budget on a cold cache. Aborting at 30s would surface as
  // `ApiUnreachableError` — blaming the caller's network for a healthy server
  // that is still cloning. The budget is internal (no new caller-facing
  // params), so the static routes' no-transport-options policy stands.

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

  it("lets a files-form resolve time out at 30s while a method_ref resolve keeps waiting", async () => {
    vi.useFakeTimers();
    vi.spyOn(globalThis, "fetch").mockImplementation(hangingFetch());
    const client = makeClient();

    const byFiles = track(client.resolve({ files: [{ content: "domain = 'smoke'\n" }] }));
    const byRef = track(
      client.resolve({ method_ref: "github.com/Pipelex/methods/documents@v0.1.0" }),
    );

    await vi.advanceTimersByTimeAsync(31_000);
    expect(byFiles.settled).toBe(true);
    expect(byFiles.error).toBeInstanceOf(ApiUnreachableError);
    expect(byRef.settled).toBe(false);

    await vi.advanceTimersByTimeAsync(180_000);
    expect(byRef.settled).toBe(true);
    expect(byRef.error).toBeInstanceOf(ApiUnreachableError);
  });

  it("gives the build projections the same budget — a method_ref buildInputs outlives 30s", async () => {
    // The build routes share `CrateRequestBase`, so an address-form closure makes
    // the server fetch there too. `buildRunner` is excluded: its own five-minute
    // default already clears the fetch budget.
    vi.useFakeTimers();
    vi.spyOn(globalThis, "fetch").mockImplementation(hangingFetch());
    const client = makeClient();

    const byFiles = track(client.buildInputs({ files: [{ content: "domain = 'smoke'\n" }] }));
    const byRef = track(
      client.buildOutput({ method_ref: "github.com/Pipelex/methods/documents@v0.1.0" }),
    );

    await vi.advanceTimersByTimeAsync(31_000);
    expect(byFiles.settled).toBe(true);
    expect(byFiles.error).toBeInstanceOf(ApiUnreachableError);
    expect(byRef.settled).toBe(false);

    await vi.advanceTimersByTimeAsync(180_000);
    expect(byRef.settled).toBe(true);
    expect(byRef.error).toBeInstanceOf(ApiUnreachableError);
  });
});

describe("crate routes — the 200 verdict", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("relays the resolved crate untouched, fingerprint and all", async () => {
    const client = makeClient();
    // The crate's schema is standard-owned and opaque to this SDK, so the test that
    // matters is that a nested, ordered payload survives the round trip byte-for-byte.
    const crate = {
      fingerprint: "sha256:abc123",
      mthds_version: "0.9.0",
      domains: { smoke: { main_pipe: "echo", pipes: { echo: { type: "PipeLLM" } } } },
    };
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      jsonResponse(200, { is_valid: true, crate, message: "MTHDS library resolved successfully" }),
    );

    const result = await client.resolve({ files: [{ content: "domain = 'smoke'" }] });

    expect(result.is_valid).toBe(true);
    const report = result as ResolveValidReport;
    expect(report.crate).toEqual(crate);
    // The fingerprint rides INSIDE the crate payload, not beside it.
    expect(report.crate.fingerprint).toBe("sha256:abc123");
  });

  it("surfaces the codegen artifacts, lock, lock_filename and crate_fingerprint verbatim", async () => {
    const client = makeClient();
    const artifacts = [
      { path: "types.ts", content: "// @generated by pipelex\nexport const Text = z.string();\n" },
    ];
    const lock = 'version = 1\n[[files]]\npath = "types.ts"\nsha256 = "deadbeef"\n';
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      jsonResponse(200, {
        is_valid: true,
        kind: "types",
        target: "ts-zod",
        crate_fingerprint: "sha256:abc123",
        engine_version: "1.2.3",
        artifacts,
        lock,
        lock_filename: "codegen.lock",
        message: "Codegen artifacts generated successfully",
      }),
    );

    const result = await client.codegen({
      files: [{ content: "domain = 'smoke'" }],
      kind: "types",
      target: "ts-zod",
    });

    expect(result.is_valid).toBe(true);
    const report = result as CodegenValidReport;
    // Byte-identical relay is the trust chain: the stamp header and the lock's exact
    // bytes are what make the offline `pipelex codegen check` pass on the written tree.
    expect(report.artifacts).toEqual(artifacts);
    expect(report.lock).toBe(lock);
    expect(report.lock_filename).toBe("codegen.lock");
    expect(report.crate_fingerprint).toBe("sha256:abc123");
    expect(report.engine_version).toBe("1.2.3");
    expect(report.kind).toBe("types");
    expect(report.target).toBe("ts-zod");
  });

  it("returns the shared invalid arm as a value on both routes — never a throw", async () => {
    const client = makeClient();
    // A fresh Response per call — a body can only be read once.
    vi.spyOn(globalThis, "fetch").mockImplementation(() =>
      Promise.resolve(jsonResponse(200, INVALID_ARM)),
    );

    for (const call of [
      () => client.resolve({ files: [{ content: "!!broken" }] }),
      () => client.codegen({ files: [{ content: "!!broken" }], kind: "types", target: "ts-zod" }),
    ]) {
      const result = await call();
      // The request was well-formed; the library was not. Nothing throws, so a consumer
      // that only catches would render a success over an unusable result.
      expect(result.is_valid).toBe(false);
      const report = result as CrateInvalidReport;
      expect(report.validation_errors[0]!.message).toBe("boom");
      expect(report.validation_errors[0]!.source).toBe("smoke.mthds");
    }
  });
});

describe("crate routes — what throws", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("throws ApiResponseError with the problem details on a request-shape 422", async () => {
    const client = makeClient();
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      problemResponse(422, "pipe_ref is not accepted for kind='types'"),
    );

    // A `pipe_ref` on the concept-set-wide `types` kind is a REQUEST-shape error, not a
    // crate verdict: nothing is wrong with the closure, so it must not come back as
    // `is_valid: false`.
    const failure = client.codegen({
      files: [{ content: "domain = 'smoke'" }],
      kind: "types",
      target: "ts-zod",
      pipe_ref: "smoke.echo",
    });
    await expect(failure).rejects.toBeInstanceOf(ApiResponseError);
    await expect(failure).rejects.toMatchObject({
      status: 422,
      serverMessage: "pipe_ref is not accepted for kind='types'",
    });
  });

  it("maps the reserved method_ref to a 501 on both routes", async () => {
    const client = makeClient();
    vi.spyOn(globalThis, "fetch").mockImplementation(() =>
      Promise.resolve(
        problemResponse(501, "method_ref resolution is not available on this server yet."),
      ),
    );

    for (const call of [
      () => client.resolve({ method_ref: "acme/method@1" }),
      () => client.codegen({ method_ref: "acme/method@1", kind: "types", target: "ts-zod" }),
    ]) {
      await expect(call()).rejects.toMatchObject({ status: 501 });
    }
  });
});
