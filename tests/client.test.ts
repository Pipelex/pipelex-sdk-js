import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PipelexApiClient } from "../src/client.js";
import { PipelexExecuteResult } from "../src/execute-result.js";
import {
  ApiResponseError,
  ApiUnreachableError,
  MissingMainStuffError,
  PipelineExecuteTimeoutError,
  PipelineRequestError,
  RunStillRunningError,
} from "../src/errors.js";

const BASE_URL = "http://localhost:8081";

function makeClient(): PipelexApiClient {
  return new PipelexApiClient({
    baseUrl: BASE_URL,
    apiKey: "test-token",
  });
}

function networkError(code: string): TypeError {
  const err = new TypeError("fetch failed") as TypeError & { cause?: { code: string } };
  err.cause = { code };
  return err;
}

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

function textResponse(status: number, body: string, statusText = ""): Response {
  return new Response(body, { status, statusText });
}

/** The JSON body of the first request a spied fetch received. */
function bodyOf(fetchSpy: ReturnType<typeof vi.spyOn>): Record<string, unknown> {
  const init = fetchSpy.mock.calls[0]![1] as { body?: string };
  return JSON.parse(init.body ?? "{}") as Record<string, unknown>;
}

beforeEach(() => {
  vi.restoreAllMocks();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("PipelexApiClient constructor", () => {
  it("defaults to the hosted base URL when nothing is configured", async () => {
    const originalUrl = process.env.PIPELEX_BASE_URL;
    delete process.env.PIPELEX_BASE_URL;
    try {
      const client = new PipelexApiClient({ apiKey: "t" });
      const fetchSpy = vi
        .spyOn(globalThis, "fetch")
        .mockResolvedValue(jsonResponse(200, { pipeline_run_id: "x" }));
      await client.execute({ pipe_code: "p" });
      expect(fetchSpy).toHaveBeenCalledWith(
        "https://api.pipelex.com/v1/execute",
        expect.objectContaining({ method: "POST" }),
      );
    } finally {
      if (originalUrl !== undefined) process.env.PIPELEX_BASE_URL = originalUrl;
    }
  });

  it("strips trailing slashes from baseUrl and composes {base}/v1/{endpoint}", async () => {
    const client = new PipelexApiClient({
      baseUrl: "http://localhost:8081///",
    });
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(jsonResponse(200, { pipeline_run_id: "x" }));
    await client.execute({ pipe_code: "p" });
    expect(fetchSpy).toHaveBeenCalledWith(
      "http://localhost:8081/v1/execute",
      expect.objectContaining({ method: "POST" }),
    );
  });

  it("rejects a path-prefixed base URL instead of composing /v1/v1/...", () => {
    // A leftover path (e.g. `.../v1`) would otherwise yield malformed
    // `/v1/v1/...` endpoints with a misleading per-request error.
    expect(() => new PipelexApiClient({ baseUrl: "https://api.pipelex.com/v1" })).toThrow(
      /host-only/,
    );
    // A trailing slash on a path prefix is still a path prefix.
    expect(() => new PipelexApiClient({ baseUrl: "https://api.pipelex.com/v1/" })).toThrow(
      /host-only/,
    );
  });

  it("reads PIPELEX_BASE_URL from the environment", async () => {
    const originalUrl = process.env.PIPELEX_BASE_URL;
    process.env.PIPELEX_BASE_URL = "http://env-host:9999";
    try {
      const client = new PipelexApiClient({ apiKey: "t" });
      const fetchSpy = vi
        .spyOn(globalThis, "fetch")
        .mockResolvedValue(jsonResponse(200, { pipeline_run_id: "x" }));
      await client.execute({ pipe_code: "p" });
      expect(fetchSpy).toHaveBeenCalledWith(
        "http://env-host:9999/v1/execute",
        expect.objectContaining({ method: "POST" }),
      );
    } finally {
      if (originalUrl !== undefined) process.env.PIPELEX_BASE_URL = originalUrl;
      else delete process.env.PIPELEX_BASE_URL;
    }
  });
});

describe("PipelexApiClient.execute argument validation", () => {
  it("throws PipelineRequestError when neither pipe_code nor mthds_contents provided", async () => {
    const client = makeClient();
    await expect(client.execute({})).rejects.toBeInstanceOf(PipelineRequestError);
  });
});

describe("PipelexApiClient hosted method_id option", () => {
  const BUNDLE = { "bundle.mthds": "domain = 'x'", "funcs/f.py": "def f(): ..." };

  function executeResponse(): Response {
    return jsonResponse(200, {
      pipeline_run_id: "run-m",
      pipe_output: { working_memory: { root: {} } },
    });
  }

  function startResponse(): Response {
    return jsonResponse(202, { pipeline_run_id: "run-m", state: "STARTED", created_at: "t0" });
  }

  it("sends the typed method_id as a top-level wire field on execute and start", async () => {
    const client = makeClient();
    const onExecute = vi.spyOn(globalThis, "fetch").mockResolvedValue(executeResponse());
    await client.execute({ method_id: "mt_1", inputs: { a: 1 } }).catch(() => undefined);
    // A top-level field, exactly as the `extra` passthrough used to emit it —
    // the wire is unchanged; only how a caller expresses it moved.
    expect(bodyOf(onExecute)).toMatchObject({ method_id: "mt_1" });
    expect(bodyOf(onExecute).extra).toBeUndefined();

    vi.restoreAllMocks();
    const onStart = vi.spyOn(globalThis, "fetch").mockResolvedValue(startResponse());
    await client.start({ method_id: "mt_1", inputs: { a: 1 } });
    expect(bodyOf(onStart)).toMatchObject({ method_id: "mt_1" });
  });

  it("accepts a method_id-only run — a stored method is something to run", async () => {
    const client = makeClient();
    // The precondition counts the hosted selector: the platform resolves the
    // stored method's source, so demanding pipe_code/mthds_contents beside it
    // would reject the app's own by-id runs.
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(startResponse());
    await client.start({ method_id: "mt_1" });
    expect(bodyOf(fetchSpy)).toEqual({ method_id: "mt_1" });
  });

  it("sends method_id ALONGSIDE an inline source — linkage, never an exclusivity violation", async () => {
    const client = makeClient();
    // The inline source is what runs (precedence); the id rides along as the
    // run-history linkage that writes the `GET /v1/runs?method_id=` index key.
    // Refusing the combination once orphaned every unsaved-bundle run from its
    // method, so it must stay legal on both encodings.
    const withContents = vi.spyOn(globalThis, "fetch").mockResolvedValue(startResponse());
    await client.start({ method_id: "mt_1", mthds_contents: ["domain = 'x'"] });
    expect(bodyOf(withContents)).toMatchObject({
      method_id: "mt_1",
      mthds_contents: ["domain = 'x'"],
    });

    vi.restoreAllMocks();
    const withBundle = vi.spyOn(globalThis, "fetch").mockResolvedValue(startResponse());
    await client.start({ method_id: "mt_1", files: BUNDLE });
    expect(bodyOf(withBundle)).toMatchObject({ method_id: "mt_1", files: BUNDLE });
  });

  it("rejects method_id smuggled through `extra` — one argument, one path", async () => {
    const client = makeClient();
    // The hosted client names this key, so it must also guard it: `extra`
    // merges last into the body, and a second path would carry different
    // validation for the same argument.
    await expect(client.execute({ extra: { method_id: "mt_1" } })).rejects.toThrow(
      /pass them as named options/,
    );
    await expect(
      client.start({ pipe_code: "p", extra: { method_id: "mt_1" } }),
    ).rejects.toBeInstanceOf(PipelineRequestError);
  });

  it("never ships an empty method_id (it selects nothing and links nothing)", async () => {
    const client = makeClient();
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(executeResponse());
    await client.execute({ pipe_code: "p", method_id: "" }).catch(() => undefined);
    expect(bodyOf(fetchSpy).method_id).toBeUndefined();
    // And it does not satisfy the precondition on its own.
    await expect(client.execute({ method_id: "" })).rejects.toBeInstanceOf(PipelineRequestError);
  });

  it("keeps method_id on the blocking fallback, so a bare runner can diagnose it", async () => {
    const client = makeClient();
    // `startAndWaitForResult` falls back to `POST /execute` against a runner
    // with no run store. Dropping the selector there would turn a server-side
    // 422 that names it into a silently different run.
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(jsonResponse(200, { implementation: "pipelex-api" }))
      .mockResolvedValue(executeResponse());
    await client
      .startAndWaitForResult({ method_id: "mt_1", pipe_code: "p" })
      .catch(() => undefined);
    const executeCall = fetchSpy.mock.calls[1]!;
    expect(String(executeCall[0])).toBe("http://localhost:8081/v1/execute");
    const body = JSON.parse((executeCall[1] as RequestInit).body as string) as Record<
      string,
      unknown
    >;
    expect(body.method_id).toBe("mt_1");
  });
});

describe("PipelexApiClient method_ref run source", () => {
  const ADDRESS = "github.com/Pipelex/methods/documents@v0.1.0";
  const BUNDLE = { "bundle.mthds": "domain = 'x'" };

  function executeResponse(): Response {
    return jsonResponse(200, {
      pipeline_run_id: "run-r",
      pipe_output: { working_memory: { root: {} } },
    });
  }

  function startResponse(): Response {
    return jsonResponse(202, {
      pipeline_run_id: "run-r",
      state: "STARTED",
      created_at: "t0",
      method_provenance: { address: ADDRESS, tag: "v0.1.0", commit_sha: "23dda75" },
    });
  }

  it("sends the typed method_ref as a top-level wire field on execute and start", async () => {
    const client = makeClient();
    const onExecute = vi.spyOn(globalThis, "fetch").mockResolvedValue(executeResponse());
    // A method_ref-only run is a complete run source — the fetched package
    // carries its `.mthds` and its entry pipe — so the precondition is satisfied.
    await client.execute({ method_ref: ADDRESS, inputs: { a: 1 } }).catch(() => undefined);
    expect(bodyOf(onExecute)).toEqual({ method_ref: ADDRESS, inputs: { a: 1 } });

    vi.restoreAllMocks();
    const onStart = vi.spyOn(globalThis, "fetch").mockResolvedValue(startResponse());
    await client.start({ method_ref: ADDRESS, inputs: { a: 1 } });
    expect(bodyOf(onStart)).toEqual({ method_ref: ADDRESS, inputs: { a: 1 } });
  });

  it("accepts pipe_code beside method_ref — it overrides the manifest's main_pipe", async () => {
    const client = makeClient();
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(startResponse());
    await client.start({ method_ref: ADDRESS, pipe_code: "documents.extract" });
    expect(bodyOf(fetchSpy)).toEqual({ method_ref: ADDRESS, pipe_code: "documents.extract" });
  });

  it("surfaces method_provenance on the start ack, typed", async () => {
    const client = makeClient();
    vi.spyOn(globalThis, "fetch").mockResolvedValue(startResponse());
    const ack = await client.start({ method_ref: ADDRESS });
    // The typed field — no index-signature cast needed.
    expect(ack.method_provenance).toEqual({
      address: ADDRESS,
      tag: "v0.1.0",
      commit_sha: "23dda75",
    });
  });

  it("preserves method_provenance on the execute result, typed", async () => {
    const client = makeClient();
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      jsonResponse(200, {
        pipeline_run_id: "run-r",
        main_stuff_name: "out",
        pipe_output: {
          working_memory: { root: { out: { concept: "native.Text", content: { text: "hi" } } } },
        },
        method_provenance: { address: ADDRESS, tag: "v0.1.0", commit_sha: "23dda75" },
      }),
    );
    const result = await client.execute({ method_ref: ADDRESS });
    expect(result.method_provenance).toEqual({
      address: ADDRESS,
      tag: "v0.1.0",
      commit_sha: "23dda75",
    });
    // Serialization still reproduces the wire shape — the key was sent, so it survives.
    expect(JSON.parse(JSON.stringify(result)).method_provenance).toEqual({
      address: ADDRESS,
      tag: "v0.1.0",
      commit_sha: "23dda75",
    });
  });

  it("rejects method_ref beside inline mthds_contents, before any fetch", async () => {
    const client = makeClient();
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    // Mirror of the server's 422 — an address is a complete run source, so
    // exactly one source per request (no linkage exception for method_ref).
    await expect(
      client.start({ method_ref: ADDRESS, mthds_contents: ["domain = 'x'"] }),
    ).rejects.toThrow(/mutually exclusive/);
    await expect(
      client.execute({ method_ref: ADDRESS, mthds_contents: ["domain = 'x'"] }),
    ).rejects.toBeInstanceOf(PipelineRequestError);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("rejects method_ref beside a method bundle (files / bundle_b64), before any fetch", async () => {
    const client = makeClient();
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    await expect(client.start({ method_ref: ADDRESS, files: BUNDLE })).rejects.toThrow(
      /method bundle/,
    );
    await expect(client.execute({ method_ref: ADDRESS, bundle_b64: "UEsDBA==" })).rejects.toThrow(
      /method bundle/,
    );
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("rejects method_ref beside method_id — an address run takes no linkage id", async () => {
    const client = makeClient();
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    await expect(client.start({ method_ref: ADDRESS, method_id: "mt_1" })).rejects.toThrow(
      /exactly one method selector/,
    );
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("still allows inline source + method_id — the documented linkage exception is untouched", async () => {
    const client = makeClient();
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(startResponse());
    await client.start({ method_id: "mt_1", mthds_contents: ["domain = 'x'"] });
    expect(bodyOf(fetchSpy)).toMatchObject({
      method_id: "mt_1",
      mthds_contents: ["domain = 'x'"],
    });
  });

  it("never ships an empty method_ref (it selects nothing)", async () => {
    const client = makeClient();
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(executeResponse());
    await client.execute({ pipe_code: "p", method_ref: "" }).catch(() => undefined);
    expect(bodyOf(fetchSpy).method_ref).toBeUndefined();
    // And it does not satisfy the precondition on its own.
    await expect(client.execute({ method_ref: "" })).rejects.toBeInstanceOf(PipelineRequestError);
  });

  it("rejects method_ref smuggled through `extra` — one argument, one path", async () => {
    const client = makeClient();
    await expect(client.execute({ extra: { method_ref: ADDRESS } })).rejects.toThrow(
      /reserved request args/,
    );
    await expect(
      client.start({ pipe_code: "p", extra: { method_ref: ADDRESS } }),
    ).rejects.toBeInstanceOf(PipelineRequestError);
  });

  it("keeps method_ref on the blocking fallback, so a bare runner runs the same package", async () => {
    const client = makeClient();
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(jsonResponse(200, { implementation: "pipelex-api" }))
      .mockResolvedValue(executeResponse());
    await client.startAndWaitForResult({ method_ref: ADDRESS }).catch(() => undefined);
    const executeCall = fetchSpy.mock.calls[1]!;
    expect(String(executeCall[0])).toBe("http://localhost:8081/v1/execute");
    const body = JSON.parse((executeCall[1] as RequestInit).body as string) as Record<
      string,
      unknown
    >;
    expect(body.method_ref).toBe(ADDRESS);
  });
});

describe("PipelexApiClient method-bundle transport", () => {
  const BUNDLE = { "bundle.mthds": "domain = 'x'", "funcs/f.py": "def f(): ..." };

  function executeResponse(): Response {
    return jsonResponse(200, {
      pipeline_run_id: "run-b",
      pipe_output: { working_memory: { root: {} } },
    });
  }

  it("sends `files` on execute — a bundle must reach the wire, not be dropped", async () => {
    const client = makeClient();
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(executeResponse());
    await client.execute({ pipe_code: "p", files: BUNDLE }).catch(() => undefined);
    expect(bodyOf(fetchSpy)).toMatchObject({ pipe_code: "p", files: BUNDLE });
  });

  it("accepts a bundle-only execute — a bundle carries its own .mthds", async () => {
    const client = makeClient();
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(executeResponse());
    await client.execute({ files: BUNDLE }).catch(() => undefined);
    const body = bodyOf(fetchSpy);
    expect(body).toMatchObject({ files: BUNDLE });
    expect(body.pipe_code).toBeUndefined();
  });

  it("sends `bundle_b64` on start", async () => {
    const client = makeClient();
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(
        jsonResponse(202, { pipeline_run_id: "run-c", state: "STARTED", created_at: "t0" }),
      );
    await client.start({ bundle_b64: "UEsDBA==" });
    expect(bodyOf(fetchSpy)).toEqual({ bundle_b64: "UEsDBA==" });
  });

  it("rejects the two bundle encodings together (presence, even when one is empty)", async () => {
    const client = makeClient();
    // Pin to the guard's own message, not just `PipelineRequestError` — a
    // transport failure (`ApiUnreachableError`) is also a `PipelineRequestError`,
    // so a bare `toBeInstanceOf` would pass even if the guard were removed and
    // the call fell through to the network.
    await expect(client.execute({ files: BUNDLE, bundle_b64: "UEs=" })).rejects.toThrow(
      /mutually exclusive/,
    );
    await expect(client.start({ files: {}, bundle_b64: "UEs=" })).rejects.toThrow(
      /mutually exclusive/,
    );
  });

  it("rejects a bundle combined with non-empty mthds_contents", async () => {
    const client = makeClient();
    await expect(
      client.execute({ files: BUNDLE, mthds_contents: ["domain = 'y'"] }),
    ).rejects.toThrow(/self-contained/);
    await expect(
      client.start({ bundle_b64: "UEs=", mthds_contents: ["domain = 'y'"] }),
    ).rejects.toThrow(/self-contained/);
  });

  it("never ships an empty bundle encoding (an empty map carries no method)", async () => {
    const client = makeClient();
    // One encoding at a time — supplying both is an exclusivity violation on
    // presence, empty or not, and is covered above.
    const withFiles = vi.spyOn(globalThis, "fetch").mockResolvedValue(executeResponse());
    await client.execute({ pipe_code: "p", files: {} }).catch(() => undefined);
    expect(bodyOf(withFiles).files).toBeUndefined();

    vi.restoreAllMocks();
    const withZip = vi.spyOn(globalThis, "fetch").mockResolvedValue(executeResponse());
    await client.execute({ pipe_code: "p", bundle_b64: "" }).catch(() => undefined);
    expect(bodyOf(withZip).bundle_b64).toBeUndefined();
  });

  it("rejects run-source fields smuggled through `extra`", async () => {
    const client = makeClient();
    // `extra` merges last into the body, so this would overwrite the validated
    // fields and bypass the exclusivity check.
    await expect(client.execute({ extra: { files: BUNDLE } })).rejects.toThrow(
      /pass them as named options/,
    );
    await expect(client.start({ extra: { bundle_b64: "UEs=" } })).rejects.toThrow(
      /pass them as named options/,
    );
  });

  it("keeps the client-only `bundleMain` hint off the wire", async () => {
    const client = makeClient();
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(executeResponse());
    await client.execute({ files: BUNDLE, bundleMain: "bundle.mthds" }).catch(() => undefined);
    expect(bodyOf(fetchSpy).bundleMain).toBeUndefined();
  });

  it("rejects the client-only `bundleMain` hint smuggled through `extra`", async () => {
    const client = makeClient();
    // `bundleMain` is documented as never-serialized; routing it through `extra`
    // must fail the same way a run source does, not leak a local path onto the wire.
    await expect(
      client.execute({ files: BUNDLE, extra: { bundleMain: "/local/secret.mthds" } }),
    ).rejects.toThrow(/pass them as named options/);
  });

  it("never emits prototype-pollution keys from `extra` onto the wire", async () => {
    const client = makeClient();
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(executeResponse());
    // An own `__proto__` is exactly what `JSON.parse` yields, and `extra` is the
    // field most likely populated from untrusted JSON — the SDK must not carry a
    // pollution gadget to a downstream JS hop.
    const extra = JSON.parse('{"__proto__":{"polluted":true},"vendor":1}') as Record<
      string,
      unknown
    >;
    await client.execute({ pipe_code: "p", extra }).catch(() => undefined);
    const raw = String((fetchSpy.mock.calls[0]![1] as RequestInit).body);
    expect(raw).not.toContain("__proto__");
    expect(bodyOf(fetchSpy).vendor).toBe(1);
  });
});

describe("PipelexApiClient network errors", () => {
  it("wraps ECONNREFUSED in ApiUnreachableError with code", async () => {
    const client = makeClient();
    vi.spyOn(globalThis, "fetch").mockRejectedValue(networkError("ECONNREFUSED"));
    try {
      await client.execute({ pipe_code: "p" });
      expect.fail("expected throw");
    } catch (err) {
      expect(err).toBeInstanceOf(ApiUnreachableError);
      expect(err).toBeInstanceOf(PipelineRequestError);
      const e = err as ApiUnreachableError;
      expect(e.code).toBe("ECONNREFUSED");
      expect(e.apiUrl).toBe(BASE_URL);
      expect(e.message).toContain(BASE_URL);
      expect(e.message).toContain("ECONNREFUSED");
      expect(e.cause).toBeInstanceOf(TypeError);
    }
  });

  it("wraps ENOTFOUND in ApiUnreachableError with code", async () => {
    const client = makeClient();
    vi.spyOn(globalThis, "fetch").mockRejectedValue(networkError("ENOTFOUND"));
    try {
      await client.execute({ pipe_code: "p" });
      expect.fail("expected throw");
    } catch (err) {
      expect(err).toBeInstanceOf(ApiUnreachableError);
      expect((err as ApiUnreachableError).code).toBe("ENOTFOUND");
    }
  });

  it("maps AbortSignal.timeout DOMException to ABORT_TIMEOUT", async () => {
    const client = makeClient();
    const timeoutErr = new DOMException("timed out", "TimeoutError");
    vi.spyOn(globalThis, "fetch").mockRejectedValue(timeoutErr);
    try {
      await client.execute({ pipe_code: "p" });
      expect.fail("expected throw");
    } catch (err) {
      expect(err).toBeInstanceOf(ApiUnreachableError);
      expect((err as ApiUnreachableError).code).toBe("ABORT_TIMEOUT");
    }
  });

  it("falls back to undefined code when cause has no code", async () => {
    const client = makeClient();
    vi.spyOn(globalThis, "fetch").mockRejectedValue(new TypeError("fetch failed"));
    try {
      await client.execute({ pipe_code: "p" });
      expect.fail("expected throw");
    } catch (err) {
      expect(err).toBeInstanceOf(ApiUnreachableError);
      expect((err as ApiUnreachableError).code).toBeUndefined();
      expect((err as ApiUnreachableError).message).toContain("network error");
    }
  });
});

describe("PipelexApiClient HTTP error responses", () => {
  it("parses 401 with detail string (auth error shape)", async () => {
    const client = makeClient();
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      jsonResponse(401, { detail: "Invalid authentication token" }),
    );
    try {
      await client.execute({ pipe_code: "p" });
      expect.fail("expected throw");
    } catch (err) {
      expect(err).toBeInstanceOf(ApiResponseError);
      const e = err as ApiResponseError;
      expect(e.status).toBe(401);
      expect(e.errorType).toBeUndefined();
      expect(e.serverMessage).toBe("Invalid authentication token");
      expect(e.responseBody).toContain("Invalid authentication token");
      expect(e.message).toContain("Invalid authentication token");
    }
  });

  it("parses 500 with nested detail dict (pipeline error shape)", async () => {
    const client = makeClient();
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      jsonResponse(500, {
        detail: { error_type: "CredentialsError", message: "Missing OPENAI_API_KEY" },
      }),
    );
    try {
      await client.execute({ pipe_code: "p" });
      expect.fail("expected throw");
    } catch (err) {
      expect(err).toBeInstanceOf(ApiResponseError);
      const e = err as ApiResponseError;
      expect(e.status).toBe(500);
      expect(e.errorType).toBe("CredentialsError");
      expect(e.serverMessage).toBe("Missing OPENAI_API_KEY");
    }
  });

  it("parses top-level error_type/message shape", async () => {
    const client = makeClient();
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      jsonResponse(500, { error_type: "FooError", message: "bar" }),
    );
    try {
      await client.execute({ pipe_code: "p" });
      expect.fail("expected throw");
    } catch (err) {
      const e = err as ApiResponseError;
      expect(e.errorType).toBe("FooError");
      expect(e.serverMessage).toBe("bar");
    }
  });

  it("retains raw body when response is non-JSON", async () => {
    const client = makeClient();
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      textResponse(502, "Bad Gateway", "Bad Gateway"),
    );
    try {
      await client.execute({ pipe_code: "p" });
      expect.fail("expected throw");
    } catch (err) {
      expect(err).toBeInstanceOf(ApiResponseError);
      const e = err as ApiResponseError;
      expect(e.status).toBe(502);
      expect(e.errorType).toBeUndefined();
      expect(e.serverMessage).toBeUndefined();
      expect(e.responseBody).toBe("Bad Gateway");
    }
  });

  it("falls back to statusText when body is empty", async () => {
    const client = makeClient();
    vi.spyOn(globalThis, "fetch").mockResolvedValue(textResponse(503, "", "Service Unavailable"));
    try {
      await client.execute({ pipe_code: "p" });
      expect.fail("expected throw");
    } catch (err) {
      const e = err as ApiResponseError;
      expect(e.message).toContain("Service Unavailable");
    }
  });
});

describe("PipelexApiClient.execute gateway 30s timeout", () => {
  it("translates a ~30s gateway 503 into a clear PipelineExecuteTimeoutError pointing at start", async () => {
    const client = makeClient();
    vi.spyOn(globalThis, "fetch").mockResolvedValue(textResponse(503, "", "Service Unavailable"));
    // start = 0ms, failure observed at 31s → over the 30s gateway ceiling.
    vi.spyOn(Date, "now").mockReturnValueOnce(0).mockReturnValueOnce(31_000);
    const err = await client.execute({ pipe_code: "p" }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(PipelineExecuteTimeoutError);
    const e = err as PipelineExecuteTimeoutError;
    expect(e.message).toContain("30s");
    expect(e.message).toContain("waitForResult");
    expect(e.elapsedMs).toBe(31_000);
  });

  it("also fires on a client-side abort timeout past the ceiling", async () => {
    const client = makeClient();
    vi.spyOn(globalThis, "fetch").mockRejectedValue(new DOMException("timed out", "TimeoutError"));
    vi.spyOn(Date, "now").mockReturnValueOnce(0).mockReturnValueOnce(30_500);
    await expect(client.execute({ pipe_code: "p" })).rejects.toBeInstanceOf(
      PipelineExecuteTimeoutError,
    );
  });

  it("leaves a fast 503 as an ordinary ApiResponseError (runner down, not a timeout)", async () => {
    const client = makeClient();
    vi.spyOn(globalThis, "fetch").mockResolvedValue(textResponse(503, "", "Service Unavailable"));
    vi.spyOn(Date, "now").mockReturnValueOnce(0).mockReturnValueOnce(2_000);
    const err = await client.execute({ pipe_code: "p" }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiResponseError);
    expect(err).not.toBeInstanceOf(PipelineExecuteTimeoutError);
  });
});

describe("PipelexApiClient.execute 202 degrade", () => {
  it("throws RunStillRunningError carrying pipeline_run_id, Retry-After, and Location", async () => {
    const client = makeClient();
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      jsonResponse(
        202,
        { pipeline_run_id: "run-202", state: "RUNNING", created_at: "t0" },
        { "Retry-After": "5", Location: "/v1/runs/run-202/status" },
      ),
    );
    const err = await client.execute({ pipe_code: "p" }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(RunStillRunningError);
    const e = err as RunStillRunningError;
    expect(e.runId).toBe("run-202");
    expect(e.retryAfterSeconds).toBe(5);
    expect(e.location).toBe("/v1/runs/run-202/status");
    expect(e.message).toContain("run-202");
  });

  it("survives a 202 with a malformed body (unknown run id)", async () => {
    const client = makeClient();
    vi.spyOn(globalThis, "fetch").mockResolvedValue(textResponse(202, "accepted"));
    const err = await client.execute({ pipe_code: "p" }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(RunStillRunningError);
    expect((err as RunStillRunningError).runId).toBe("");
    expect((err as RunStillRunningError).message).toContain("<unknown>");
  });
});

describe("PipelexApiClient happy path", () => {
  it("returns the parsed RunResult on 200", async () => {
    const client = makeClient();
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      jsonResponse(200, { pipeline_run_id: "ok", created_at: "t0", state: "COMPLETED" }),
    );
    const result = await client.execute({ pipe_code: "p" });
    expect(result.pipeline_run_id).toBe("ok");
    expect(result.state).toBe("COMPLETED"); // server extension field, preserved via the index signature
  });
});

describe("PipelexApiClient.execute resolves main_stuff", () => {
  // A completed execute response: `main_stuff_name` ("result") names the working-memory root key
  // the `.main_stuff` accessor resolves to — the same accessor as the durable path.
  function executeBody(
    mainStuffName: string,
    root: Record<string, unknown>,
  ): Record<string, unknown> {
    return {
      pipeline_run_id: "run-x",
      main_stuff_name: mainStuffName,
      pipe_output: { working_memory: { root, aliases: {} }, pipeline_run_id: "run-x" },
    };
  }

  it("resolves .main_stuff out of the working memory", async () => {
    const client = makeClient();
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      jsonResponse(
        200,
        executeBody("result", { result: { concept: "native.Text", content: { text: "hi" } } }),
      ),
    );
    const result = await client.execute({ pipe_code: "p" });
    expect(result.pipeline_run_id).toBe("run-x");
    expect(result.main_stuff).toEqual({ text: "hi" });
  });

  it("throws MissingMainStuffError when .main_stuff names no locatable stuff", async () => {
    const client = makeClient();
    // `main_stuff_name` names "missing", absent from the working-memory root.
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      jsonResponse(200, executeBody("missing", { other: { concept: "native.Text", content: {} } })),
    );
    const result = await client.execute({ pipe_code: "p" });
    // The accessor throws lazily on read (the run completed; the response is otherwise fine).
    expect(() => result.main_stuff).toThrow(MissingMainStuffError);
  });

  it("throws MissingMainStuffError when the located stuff has null content", async () => {
    const client = makeClient();
    // The named entry exists but its resolved `content` is null — the durable path rejects a
    // null resolved main stuff, so the blocking accessor must too (one-accessor invariant).
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      jsonResponse(
        200,
        executeBody("result", { result: { concept: "native.Text", content: null } }),
      ),
    );
    const result = await client.execute({ pipe_code: "p" });
    expect(() => result.main_stuff).toThrow(MissingMainStuffError);
  });

  it("returns a falsy-but-present main stuff as-is (empty array, 0)", async () => {
    const client = makeClient();
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      jsonResponse(200, executeBody("result", { result: { concept: "native.Text", content: [] } })),
    );
    const emptyArr = await client.execute({ pipe_code: "p" });
    expect(emptyArr.main_stuff).toEqual([]);

    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      jsonResponse(
        200,
        executeBody("result", { result: { concept: "native.Number", content: 0 } }),
      ),
    );
    const zero = await client.execute({ pipe_code: "p" });
    expect(zero.main_stuff).toBe(0);
  });

  it("preserves extension fields whose names collide with Object.prototype members", async () => {
    const client = makeClient();
    // `toString` is a legitimate extension-open wire field; the constructor's copy loop must not
    // drop it just because the name exists on the prototype chain.
    const body: Record<string, unknown> = {
      ...executeBody("result", { result: { concept: "native.Text", content: { text: "hi" } } }),
      toString: "server-value",
    };
    vi.spyOn(globalThis, "fetch").mockResolvedValue(jsonResponse(200, body));
    const result = await client.execute({ pipe_code: "p" });
    expect((result as Record<string, unknown>).toString).toBe("server-value");
    // The main_stuff getter is still intact (not shadowed by the copy loop).
    expect(result.main_stuff).toEqual({ text: "hi" });
  });

  it("does not let a __proto__ wire field pollute the instance prototype", async () => {
    const client = makeClient();
    // JSON.parse materializes a `"__proto__"` key as an OWN data property (not via the setter),
    // so the server can smuggle one through the wire. The copy loop must not assign it — doing so
    // would trip the Object.prototype `__proto__` setter and mutate the instance prototype.
    const body: Record<string, unknown> = executeBody("result", {
      result: { concept: "native.Text", content: { text: "hi" } },
    });
    Object.defineProperty(body, "__proto__", {
      value: { polluted: true },
      enumerable: true,
      writable: true,
      configurable: true,
    });
    vi.spyOn(globalThis, "fetch").mockResolvedValue(jsonResponse(200, body));
    const result = await client.execute({ pipe_code: "p" });
    // Prototype unchanged and no pollution leaked onto the instance.
    expect(Object.getPrototypeOf(result)).toBe(PipelexExecuteResult.prototype);
    expect((result as Record<string, unknown>).polluted).toBeUndefined();
    // The accessor still resolves normally.
    expect(result.main_stuff).toEqual({ text: "hi" });
  });
});

describe("PipelexApiClient.start", () => {
  it("POSTs /v1/start and returns the RunResult ack", async () => {
    const client = makeClient();
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(
        jsonResponse(202, { pipeline_run_id: "run-1", state: "STARTED", created_at: "t0" }),
      );

    const ack = await client.start({
      pipe_code: "my_pipe",
      mthds_contents: ["domain = 'x'"],
      inputs: { a: 1 },
    });

    expect(ack.pipeline_run_id).toBe("run-1");
    const [url, init] = fetchSpy.mock.calls[0]!;
    expect(url).toBe("http://localhost:8081/v1/start");
    expect(init).toMatchObject({ method: "POST" });
    expect(JSON.parse((init as RequestInit).body as string)).toEqual({
      pipe_code: "my_pipe",
      mthds_contents: ["domain = 'x'"],
      inputs: { a: 1 },
    });
  });

  it("merges extension args from extra into the body (extension-only start is accepted)", async () => {
    const client = makeClient();
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(
        jsonResponse(202, { pipeline_run_id: "run-2", state: "STARTED", created_at: "t0" }),
      );
    await client.start({ inputs: { q: "hi" }, extra: { some_vendor_selector: "sel_123" } });
    const body = JSON.parse((fetchSpy.mock.calls[0]![1] as RequestInit).body as string);
    expect(body).toEqual({ some_vendor_selector: "sel_123", inputs: { q: "hi" } });
    expect(body.pipe_code).toBeUndefined();
    expect(body.mthds_contents).toBeUndefined();
    expect(body.extra).toBeUndefined();
  });

  it("passes a client-supplied pipeline_run_id through extra (server-defined extension)", async () => {
    const client = makeClient();
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(
        jsonResponse(202, { pipeline_run_id: "client-id", state: "STARTED", created_at: "t0" }),
      );
    await client.start({
      pipe_code: "p",
      extra: { pipeline_run_id: "client-id" },
    });
    const body = JSON.parse((fetchSpy.mock.calls[0]![1] as RequestInit).body as string);
    expect(body.pipeline_run_id).toBe("client-id");
  });

  it("rejects protocol args smuggled through extra", async () => {
    const client = makeClient();
    await expect(
      client.start({ mthds_contents: ["domain d"], extra: { pipe_code: "smuggled" } }),
    ).rejects.toBeInstanceOf(PipelineRequestError);
  });

  it("throws PipelineRequestError when pipe_code, mthds_contents, and extra are all missing", async () => {
    const client = makeClient();
    await expect(client.start({})).rejects.toBeInstanceOf(PipelineRequestError);
  });

  it("surfaces a non-2xx start as ApiResponseError (hosted 422 on client pipeline_run_id)", async () => {
    const client = makeClient();
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      jsonResponse(422, { detail: "Client-supplied pipeline_run_id is not accepted" }),
    );
    const err = await client
      .start({ pipe_code: "p", pipeline_run_id: "nope" } as never)
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiResponseError);
    expect((err as ApiResponseError).status).toBe(422);
  });
});

describe("PipelexApiClient.validate", () => {
  it("POSTs /v1/validate with mthds_contents + allow_signatures and returns the valid report", async () => {
    const client = makeClient();
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      jsonResponse(200, {
        is_valid: true,
        bundle_blueprint: { domain: "x" },
        graph_spec: null,
        pipe_io_contracts: {},
        validated_pipes: [],
        pending_signatures: [],
        is_runnable: true,
      }),
    );

    const report = await client.validate(["domain = 'x'"], true);

    expect(report.is_valid).toBe(true);
    if (report.is_valid === false) throw new Error("expected a valid report");
    expect(report.bundle_blueprint).toEqual({ domain: "x" });
    expect(report.is_runnable).toBe(true);
    const [url, init] = fetchSpy.mock.calls[0]!;
    expect(url).toBe("http://localhost:8081/v1/validate");
    expect(JSON.parse((init as RequestInit).body as string)).toEqual({
      mthds_contents: ["domain = 'x'"],
      allow_signatures: true,
      render: ["markdown"],
    });
  });

  it("defaults allow_signatures to false", async () => {
    const client = makeClient();
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(jsonResponse(200, { is_valid: true }));
    await client.validate(["domain = 'x'"]);
    const body = JSON.parse((fetchSpy.mock.calls[0]![1] as RequestInit).body as string);
    expect(body.allow_signatures).toBe(false);
  });

  it("returns the typed PipelexValidationReport fields on a valid 200", async () => {
    const client = makeClient();
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      jsonResponse(200, {
        is_valid: true,
        bundle_blueprint: { domain: "x" },
        pipe_io_contracts: {
          "x.greet": {
            inputs: {
              who: {
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
            },
          },
        },
        input_form: {
          "x.greet": {
            fields: [
              {
                name: "who",
                kind: "prose",
                concept_ref: "native.Text",
                required: true,
                presence: "plain",
                gating: true,
              },
            ],
          },
        },
        liftable_pipes: [
          {
            pipe_ref: "x.enrich",
            within_pipe_ref: "x.greet",
            skipped_when_absent: ["profile"],
            absence_source: "optional input `profile`",
          },
        ],
        graph_spec: null,
        validated_pipes: [{ pipe_ref: "x.greet", status: "SUCCESS" }],
        warnings: [],
        pending_signatures: [],
        is_runnable: true,
        message: "MTHDS content validated successfully",
        mthds_contents: ["domain = 'x'"],
      }),
    );
    // Asks for the `input_form` view, because the fixture below carries it: the server
    // gates that field on the token, so a no-`views` request would never see it.
    const report = await client.validate(["domain = 'x'"], false, undefined, undefined, [
      "input_form",
    ]);
    expect(report.is_valid).toBe(true);
    if (report.is_valid === false) throw new Error("expected a valid report");
    expect(report.validated_pipes[0]).toEqual({ pipe_ref: "x.greet", status: "SUCCESS" });
    expect(report.pending_signatures).toEqual([]);
    expect(report.is_runnable).toBe(true);
    expect(report.graph_spec).toBeNull();
    expect(report.warnings).toEqual([]);
    // `input_form` is keyed exactly like `pipe_io_contracts` — the invariant a renderer
    // relies on to address a pipe's form by the ref it already holds.
    expect(Object.keys(report.input_form ?? {})).toEqual(Object.keys(report.pipe_io_contracts));
    expect(report.liftable_pipes[0]).toEqual({
      pipe_ref: "x.enrich",
      within_pipe_ref: "x.greet",
      skipped_when_absent: ["profile"],
      absence_source: "optional input `profile`",
    });
  });

  it("carries advisory warnings on the VALID arm, with the valid arm's explicit nulls", async () => {
    const client = makeClient();
    // The valid arm is dumped WITHOUT `exclude_none`, so an unset locator arrives as an
    // explicit `null` here — where the invalid arm drops the key entirely. Same item type,
    // two serializations: this pins that a truthiness check reads both.
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      jsonResponse(200, {
        is_valid: true,
        bundle_blueprint: { domain: "x" },
        pipe_io_contracts: {},
        liftable_pipes: [],
        graph_spec: null,
        validated_pipes: [],
        warnings: [
          {
            category: "pipe_validation",
            message: "the `!` on `profile` is redundant — the slot is always present",
            error_type: "optional_force_redundant",
            pipe_code: "x.greet",
            concept_code: null,
            source: null,
            field_name: null,
            variable_names: null,
            suggested_fix: null,
          },
        ],
        pending_signatures: [],
        is_runnable: true,
        message: "MTHDS content validated successfully",
        mthds_contents: ["domain = 'x'"],
      }),
    );
    const report = await client.validate(["domain = 'x'"]);
    if (report.is_valid === false) throw new Error("expected a valid report");
    // Advisory items never flip the verdict.
    expect(report.is_valid).toBe(true);
    expect(report.warnings).toHaveLength(1);
    const warning = report.warnings[0]!;
    expect(warning.error_type).toBe("optional_force_redundant");
    expect(warning.pipe_code).toBe("x.greet");
    expect(warning.source).toBeNull();
    expect(warning.suggested_fix).toBeNull();
  });

  it("returns the InvalidReport arm (200, is_valid: false) for an invalid bundle — not a throw", async () => {
    const client = makeClient();
    // The 200-diagnostic contract: an invalid bundle is a produced verdict, not a
    // transport failure. The body carries the discriminant + the structured list
    // (the threaded `source` per the mthds_sources hook), no structural artifacts.
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      jsonResponse(200, {
        is_valid: false,
        validation_errors: [
          {
            category: "blueprint_validation",
            message: "missing main pipe output",
            source: "broken.mthds",
            domain_code: "demo",
          },
          {
            category: "pipe_factory",
            message: "unknown concept demo.Missing",
            pipe_code: "demo.greet",
            missing_concept_code: "demo.Missing",
          },
          {
            category: "pipe_validation",
            message: "sequence output does not match its last step",
            pipe_code: "demo.flow",
            missing_pipe_code: "demo.summarize",
            suggested_fix: {
              fix_code: "match-sequence-output",
              description: "Point the sequence output at its last step's output.",
              safety: "safe",
              source: "broken.mthds",
              ops: [
                {
                  kind: "set_key",
                  table_path: ["pipe", "flow"],
                  key: "output",
                  value: "demo.Summary",
                },
                {
                  kind: "rename_table_key",
                  table_path: ["pipe", "flow"],
                  key: "outputs",
                  new_key: "output",
                },
              ],
            },
          },
        ],
        pending_signatures: [],
        is_runnable: false,
        message: "MTHDS validation found errors",
      }),
    );
    const report = await client.validate(["broken"], false, ["broken.mthds"]);
    expect(report.is_valid).toBe(false);
    if (report.is_valid !== false) throw new Error("expected an invalid report");
    expect(report.is_runnable).toBe(false);
    expect(report.validation_errors).toHaveLength(3);
    expect(report.validation_errors[0]).toMatchObject({
      category: "blueprint_validation",
      source: "broken.mthds",
    });
    expect(report.validation_errors[1]!.category).toBe("pipe_factory");
    expect(report.validation_errors[1]!.missing_concept_code).toBe("demo.Missing");
    // The invalid arm carries no `warnings` — advisories live on the valid arm only.
    expect("warnings" in report).toBe(false);

    const fix = report.validation_errors[2]!.suggested_fix!;
    expect(report.validation_errors[2]!.missing_pipe_code).toBe("demo.summarize");
    expect(fix.fix_code).toBe("match-sequence-output");
    expect(fix.safety).toBe("safe");
    expect(fix.ops).toHaveLength(2);
    // `kind` narrows the union: each arm's own members are reachable without a cast.
    const [setKey, rename] = fix.ops;
    if (setKey?.kind !== "set_key") throw new Error("expected a set_key op");
    expect(setKey.value).toBe("demo.Summary");
    expect(setKey.table_path).toEqual(["pipe", "flow"]);
    if (rename?.kind !== "rename_table_key") throw new Error("expected a rename_table_key op");
    expect(rename.new_key).toBe("output");
  });

  it("sends mthds_sources parallel to mthds_contents when provided", async () => {
    const client = makeClient();
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(jsonResponse(200, { is_valid: true }));
    await client.validate(["domain = 'x'", "domain = 'y'"], true, ["x.mthds", "y.mthds"]);
    const body = JSON.parse((fetchSpy.mock.calls[0]![1] as RequestInit).body as string);
    expect(body).toEqual({
      mthds_contents: ["domain = 'x'", "domain = 'y'"],
      allow_signatures: true,
      mthds_sources: ["x.mthds", "y.mthds"],
      render: ["markdown"],
    });
  });

  it("omits mthds_sources from the body when not provided", async () => {
    const client = makeClient();
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(jsonResponse(200, { is_valid: true }));
    await client.validate(["domain = 'x'"]);
    const body = JSON.parse((fetchSpy.mock.calls[0]![1] as RequestInit).body as string);
    expect("mthds_sources" in body).toBe(false);
  });

  it("throws ApiResponseError on a request-shape 422 (mthds_sources length mismatch)", async () => {
    const client = makeClient();
    // The no-verdict path: pipelex-api's RequestValidationError handler emits an
    // RFC 7807 problem with a top-level error_type "ValidationError" and a string
    // detail. A produced verdict never 422s — only request-shape errors do.
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      jsonResponse(
        422,
        {
          error_type: "ValidationError",
          detail: "mthds_sources length must match mthds_contents",
        },
        { "content-type": "application/problem+json" },
      ),
    );
    const err = await client.validate(["x"], false, ["a", "b"]).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiResponseError);
    expect((err as ApiResponseError).status).toBe(422);
    expect((err as ApiResponseError).errorType).toBe("ValidationError");
    expect((err as ApiResponseError).validationErrors).toBeUndefined();
  });
});

describe("PipelexApiClient.validate method selectors", () => {
  const ADDRESS = "github.com/Pipelex/methods/documents@v0.1.0";

  it("POSTs a method_ref body — validate-by-address is a server pass-through", async () => {
    const client = makeClient();
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(jsonResponse(200, { is_valid: true }));

    await client.validate({ method_ref: ADDRESS }, true);

    const [url, init] = fetchSpy.mock.calls[0]!;
    expect(url).toBe("http://localhost:8081/v1/validate");
    expect(JSON.parse((init as RequestInit).body as string)).toEqual({
      method_ref: ADDRESS,
      allow_signatures: true,
      render: ["markdown"],
    });
  });

  it("POSTs a method_id body — validate-by-id is a hosted pass-through", async () => {
    const client = makeClient();
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(jsonResponse(200, { is_valid: true }));

    await client.validate({ method_id: "mt_1" });

    expect(JSON.parse((fetchSpy.mock.calls[0]![1] as RequestInit).body as string)).toEqual({
      method_id: "mt_1",
      allow_signatures: false,
      render: ["markdown"],
    });
  });

  it("keeps render and views riding beside a selector", async () => {
    const client = makeClient();
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(jsonResponse(200, { is_valid: true }));

    await client.validate({ method_ref: ADDRESS }, false, undefined, undefined, ["input_form"]);

    const body = JSON.parse((fetchSpy.mock.calls[0]![1] as RequestInit).body as string);
    expect(body.render).toEqual(["markdown"]);
    expect(body.views).toEqual(["input_form"]);
  });

  it("rejects a both-selectors object — the tooling XOR is strict, before any fetch", async () => {
    const client = makeClient();
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    // Type-blocked (`ValidateMethodSelector` pins the other key to `never`);
    // the runtime guard backs it for untyped callers.
    await expect(
      client.validate({ method_ref: ADDRESS, method_id: "mt_1" } as never),
    ).rejects.toThrow(/exactly one method selector/);
    // An empty selector object is just as under-specified.
    await expect(client.validate({} as never)).rejects.toBeInstanceOf(PipelineRequestError);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("rejects a null/non-object source with the typed error, not a native TypeError", async () => {
    const client = makeClient();
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    // An untyped caller can pass anything; every malformed source must stay
    // inside the documented error hierarchy.
    await expect(client.validate(null as never)).rejects.toBeInstanceOf(PipelineRequestError);
    await expect(client.validate(undefined as never)).rejects.toBeInstanceOf(PipelineRequestError);
    await expect(client.validate("domain = 'x'" as never)).rejects.toBeInstanceOf(
      PipelineRequestError,
    );
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("rejects mthds_sources beside a selector — labels come from the package's real files", async () => {
    const client = makeClient();
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    await expect(client.validate({ method_ref: ADDRESS }, false, ["a.mthds"])).rejects.toThrow(
      /mthds_sources/,
    );
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("surfaces a selector-resolution failure as a non-2xx ApiResponseError, never a verdict", async () => {
    const client = makeClient();
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      jsonResponse(422, {
        status: 422,
        title: "Unprocessable Entity",
        detail: "No package found at the address.",
      }),
    );
    const failure = client.validate({ method_ref: ADDRESS });
    await expect(failure).rejects.toBeInstanceOf(ApiResponseError);
    await expect(failure).rejects.toMatchObject({ status: 422 });
  });
});

describe("PipelexApiClient.validateFiles", () => {
  it("sends content and sources for files that all have URIs", async () => {
    const client = makeClient();
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(jsonResponse(200, { is_valid: true }));

    await client.validateFiles(
      [
        { uri: "file:///bundle/main.mthds", content: "domain = 'x'" },
        { uri: "file:///bundle/pipes.mthds", content: "pipe x.greet" },
      ],
      { allowSignatures: true },
    );

    expect(fetchSpy.mock.calls[0]![0]).toBe("http://localhost:8081/v1/validate");
    expect(bodyOf(fetchSpy)).toEqual({
      mthds_contents: ["domain = 'x'", "pipe x.greet"],
      allow_signatures: true,
      mthds_sources: ["file:///bundle/main.mthds", "file:///bundle/pipes.mthds"],
      render: ["markdown"],
    });
  });

  it("omits mthds_sources when no file has a URI", async () => {
    const client = makeClient();
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(jsonResponse(200, { is_valid: true }));

    await client.validateFiles([{ content: "domain = 'x'" }, { content: "pipe x.greet" }]);

    expect(bodyOf(fetchSpy)).toEqual({
      mthds_contents: ["domain = 'x'", "pipe x.greet"],
      allow_signatures: false,
      render: ["markdown"],
    });
  });

  it("fills deterministic inline sources for missing URIs in mixed input", async () => {
    const client = makeClient();
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(jsonResponse(200, { is_valid: true }));

    await client.validateFiles([
      { uri: "file:///bundle/main.mthds", content: "domain = 'x'" },
      { content: "pipe x.inline" },
      { uri: "file:///bundle/other.mthds", content: "pipe x.other" },
    ]);

    expect(bodyOf(fetchSpy)).toMatchObject({
      mthds_contents: ["domain = 'x'", "pipe x.inline", "pipe x.other"],
      mthds_sources: [
        "file:///bundle/main.mthds",
        "inline://file-2.mthds",
        "file:///bundle/other.mthds",
      ],
      render: ["markdown"],
    });
  });

  it("rejects empty files before calling the API", async () => {
    const client = makeClient();
    const fetchSpy = vi.spyOn(globalThis, "fetch");

    await expect(client.validateFiles([])).rejects.toBeInstanceOf(PipelineRequestError);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("passes render options through to validate", async () => {
    const client = makeClient();
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(jsonResponse(200, { is_valid: true, rendered_markdown: "# ok" }));

    await client.validateFiles([{ content: "domain = 'x'" }], { render: ["markdown"] });

    expect(bodyOf(fetchSpy)).toEqual({
      mthds_contents: ["domain = 'x'"],
      allow_signatures: false,
      render: ["markdown"],
    });
  });

  // validate/validateFiles default to the 20-min execute ceiling; a bounded
  // consumer (the post-edit hook) needs a per-call ceiling that actually aborts
  // the fetch, not a Promise.race that leaves the request running.
  describe("timeout and abort options", () => {
    function hangingFetch(): typeof fetch {
      return ((_url: string, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => reject(init.signal?.reason), {
            once: true,
          });
        })) as typeof fetch;
    }

    afterEach(() => {
      vi.useRealTimers();
    });

    it("honors a caller-supplied timeoutMs, aborting the request itself", async () => {
      vi.useFakeTimers();
      const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(hangingFetch());
      const client = makeClient();

      const failure = client
        .validateFiles([{ content: "domain = 'x'" }], { timeoutMs: 1_000 })
        .catch((e: unknown) => e);

      await vi.advanceTimersByTimeAsync(1_500);
      const err = await failure;
      expect(err).toBeInstanceOf(ApiUnreachableError);
      expect((err as ApiUnreachableError).code).toBe("ABORT_TIMEOUT");
      // The fetch itself was handed an abort signal that has fired.
      const init = fetchSpy.mock.calls[0]![1] as RequestInit;
      expect(init.signal?.aborted).toBe(true);
    });

    it("lets a caller-supplied signal abort validate, propagating the reason untouched", async () => {
      vi.useFakeTimers();
      vi.spyOn(globalThis, "fetch").mockImplementation(hangingFetch());
      const client = makeClient();

      const controller = new AbortController();
      const walkAway = new Error("caller walked away");
      const failure = client
        .validateFiles([{ content: "domain = 'x'" }], { signal: controller.signal })
        .catch((e: unknown) => e);

      controller.abort(walkAway);
      await vi.advanceTimersByTimeAsync(0);
      expect(await failure).toBe(walkAway);
    });
  });
});

describe("PipelexApiClient.models", () => {
  it("GETs /v1/models and returns the deck", async () => {
    const client = makeClient();
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      jsonResponse(200, {
        models: [{ name: "gpt-4o", type: "llm" }],
        aliases: {},
        waterfalls: {},
      }),
    );
    const deck = await client.models();
    expect(deck.models[0]!.name).toBe("gpt-4o");
    expect(fetchSpy.mock.calls[0]![0]).toBe("http://localhost:8081/v1/models");
  });

  it("passes the category filter as ?type=", async () => {
    const client = makeClient();
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(jsonResponse(200, { models: [], aliases: {}, waterfalls: {} }));
    await client.models("img_gen");
    expect(fetchSpy.mock.calls[0]![0]).toBe("http://localhost:8081/v1/models?type=img_gen");
  });
});

describe("PipelexApiClient.version", () => {
  it("GETs /v1/version and returns the VersionInfo handshake", async () => {
    const client = makeClient();
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      jsonResponse(200, {
        protocol_version: "0.6.0",
        implementation: "pipelex-api",
        implementation_version: "1.2.3",
        runtime_version: "0.32.0",
      }),
    );
    const info = await client.version();
    expect(info.implementation).toBe("pipelex-api");
    expect(info.protocol_version).toBe("0.6.0");
    expect(info.runtime_version).toBe("0.32.0");
    // Typed extension field — clients gate capabilities on it without reaching
    // through the untyped index signature.
    const implVersion: string | undefined = info.implementation_version;
    expect(implVersion).toBe("1.2.3");
    expect(fetchSpy.mock.calls[0]![0]).toBe("http://localhost:8081/v1/version");
  });
});

describe("PipelexApiClient.validate render extra", () => {
  it("sends markdown render in the request body when asked", async () => {
    const client = makeClient();
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(
        jsonResponse(200, { is_valid: true, rendered_markdown: "# Validation passed" }),
      );
    await client.validate(["domain = 'x'"], false, undefined, ["markdown"]);
    expect(bodyOf(fetchSpy).render).toEqual(["markdown"]);
  });

  it("requests markdown render when none is requested", async () => {
    const client = makeClient();
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(
        jsonResponse(200, { is_valid: true, rendered_markdown: "# Validation passed" }),
      );
    await client.validate(["domain = 'x'"], false);
    expect(bodyOf(fetchSpy).render).toEqual(["markdown"]);
  });

  it("requests markdown render when given an empty list", async () => {
    const client = makeClient();
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(
        jsonResponse(200, { is_valid: true, rendered_markdown: "# Validation passed" }),
      );
    await client.validate(["domain = 'x'"], false, undefined, []);
    expect(bodyOf(fetchSpy).render).toEqual(["markdown"]);
  });

  it("keeps caller render tokens while adding markdown", async () => {
    const client = makeClient();
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(
        jsonResponse(200, { is_valid: true, rendered_markdown: "# Validation passed" }),
      );
    await client.validate(["domain = 'x'"], false, undefined, ["html"]);
    expect(bodyOf(fetchSpy).render).toEqual(["html", "markdown"]);
  });
});

describe("PipelexApiClient.validate views opt-in", () => {
  it("sends the views tokens in the request body when asked", async () => {
    const client = makeClient();
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(jsonResponse(200, { is_valid: true, input_form: {} }));
    await client.validate(["domain = 'x'"], false, undefined, undefined, ["input_form"]);
    expect(bodyOf(fetchSpy).views).toEqual(["input_form"]);
  });

  it("omits the views key entirely when the caller asks for no view", async () => {
    const client = makeClient();
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(jsonResponse(200, { is_valid: true }));
    await client.validate(["domain = 'x'"]);
    // The invariant that keeps an opt-in view opt-in: no token asked, no key sent, so
    // the response stays byte-identical for every consumer that does not want it.
    expect("views" in bodyOf(fetchSpy)).toBe(false);
  });

  it("sends an explicitly empty views list verbatim", async () => {
    const client = makeClient();
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(jsonResponse(200, { is_valid: true }));
    await client.validate(["domain = 'x'"], false, undefined, undefined, []);
    expect(bodyOf(fetchSpy).views).toEqual([]);
  });

  it("threads views through validateFiles", async () => {
    const client = makeClient();
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(jsonResponse(200, { is_valid: true, input_form: {} }));
    await client.validateFiles([{ content: "domain = 'x'" }], { views: ["input_form"] });
    expect(bodyOf(fetchSpy).views).toEqual(["input_form"]);
  });
});

describe("PipelexApiClient.lint", () => {
  it("POSTs /v1/lint and returns the diagnostics of a clean file", async () => {
    const client = makeClient();
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(jsonResponse(200, { diagnostics: [] }));
    const result = await client.lint("domain = 'x'");
    expect(result.diagnostics).toEqual([]);
    expect(fetchSpy.mock.calls[0]![0]).toBe("http://localhost:8081/v1/lint");
    expect(bodyOf(fetchSpy)).toEqual({ content: "domain = 'x'" });
  });

  it("returns malformed content as a 200 verdict rather than throwing", async () => {
    const client = makeClient();
    const diagnostic = {
      kind: "syntax",
      severity: "error",
      message: "expected '='",
      location: null,
      range: {
        start_offset: 0,
        end_offset: 6,
        start_line: 1,
        start_col: 1,
        end_line: 1,
        end_col: 7,
      },
    };
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      jsonResponse(200, { diagnostics: [diagnostic] }),
    );
    const result = await client.lint("domain");
    expect(result.diagnostics[0]!.kind).toBe("syntax");
    expect(result.diagnostics[0]!.range?.end_col).toBe(7);
  });

  it("sends the optional source label when given", async () => {
    const client = makeClient();
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(jsonResponse(200, { diagnostics: [] }));
    await client.lint("domain = 'x'", "recipe.mthds");
    expect(bodyOf(fetchSpy)).toEqual({ content: "domain = 'x'", source: "recipe.mthds" });
  });

  it("omits source from the wire body when not given", async () => {
    const client = makeClient();
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(jsonResponse(200, { diagnostics: [] }));
    await client.lint("domain = 'x'");
    expect("source" in bodyOf(fetchSpy)).toBe(false);
  });

  it("maps a non-2xx problem response to ApiResponseError", async () => {
    const client = makeClient();
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      jsonResponse(422, { detail: { error_type: "RequestValidationError", message: "bad body" } }),
    );
    await expect(client.lint("domain = 'x'")).rejects.toBeInstanceOf(ApiResponseError);
  });
});

describe("PipelexApiClient.format", () => {
  it("POSTs /v1/format and returns the formatted content", async () => {
    const client = makeClient();
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      jsonResponse(200, {
        formatted: "domain = 'x'\n",
        changed: true,
        diagnostics: [],
      }),
    );
    const result = await client.format("domain='x'");
    expect(result.formatted).toBe("domain = 'x'\n");
    expect(result.changed).toBe(true);
    expect(fetchSpy.mock.calls[0]![0]).toBe("http://localhost:8081/v1/format");
    expect(bodyOf(fetchSpy)).toEqual({ content: "domain='x'" });
  });

  it("returns a syntax error as a 200 verdict with unchanged content", async () => {
    const client = makeClient();
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      jsonResponse(200, {
        formatted: "domain",
        changed: false,
        diagnostics: [
          {
            kind: "syntax",
            severity: "error",
            message: "expected '='",
            location: null,
            range: null,
          },
        ],
      }),
    );
    const result = await client.format("domain");
    expect(result.changed).toBe(false);
    expect(result.formatted).toBe("domain");
    expect(result.diagnostics).toHaveLength(1);
  });

  it("passes formatter options through to the server", async () => {
    const client = makeClient();
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(jsonResponse(200, { formatted: "", changed: false, diagnostics: [] }));
    await client.format("domain = 'x'", { column_width: 100 });
    expect(bodyOf(fetchSpy)).toEqual({
      content: "domain = 'x'",
      options: { column_width: 100 },
    });
  });

  it("maps malformed formatter options (422) to ApiResponseError", async () => {
    const client = makeClient();
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      jsonResponse(422, { detail: { error_type: "ValueError", message: "bad column_width" } }),
    );
    await expect(client.format("domain = 'x'", { column_width: "wide" })).rejects.toMatchObject({
      status: 422,
    });
  });
});
