import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { PipelexApiClient } from "../src/client.js";
import { ApiResponseError, EmptyMethodSourceError } from "../src/errors.js";

const BASE_URL = "http://localhost:8081";

function makeClient(): PipelexApiClient {
  return new PipelexApiClient({ baseUrl: BASE_URL, apiKey: "test-token" });
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

/** A `GET /v1/methods/{id}` 200 carrying `mthds` as its polymorphic source. */
function methodResponse(methodId: string, mthds: string): Response {
  return jsonResponse(200, {
    method_id: methodId,
    name: "M",
    mthds,
    created_at: "t",
    updated_at: "t",
  });
}

beforeEach(() => {
  vi.restoreAllMocks();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("getMethodClosure", () => {
  it("resolves a raw-source method to one file labelled with the method id", async () => {
    const client = makeClient();
    const source = 'domain = "demo"\nmain_pipe = "main"';
    vi.spyOn(globalThis, "fetch").mockResolvedValue(methodResponse("mt_raw", source));

    const files = await client.getMethodClosure("mt_raw");

    expect(files).toEqual([{ content: source, source: "mt_raw" }]);
  });

  it("resolves a file-array method to N files, each labelled with the method id", async () => {
    const client = makeClient();
    const mthds = JSON.stringify([
      { name: "bundle.mthds", content: 'domain = "demo"' },
      { name: "pipes.mthds", content: 'main_pipe = "main"' },
    ]);
    vi.spyOn(globalThis, "fetch").mockResolvedValue(methodResponse("mt_arr", mthds));

    const files = await client.getMethodClosure("mt_arr");

    expect(files).toEqual([
      { content: 'domain = "demo"', source: "mt_arr" },
      { content: 'main_pipe = "main"', source: "mt_arr" },
    ]);
  });

  it("throws EmptyMethodSourceError when the stored source parses to nothing", async () => {
    const client = makeClient();
    vi.spyOn(globalThis, "fetch").mockResolvedValue(methodResponse("mt_empty", "[]"));

    const err = await client.getMethodClosure("mt_empty").catch((e: unknown) => e);

    expect(err).toBeInstanceOf(EmptyMethodSourceError);
    expect((err as EmptyMethodSourceError).methodId).toBe("mt_empty");
  });

  it("throws EmptyMethodSourceError for a whitespace-only raw source", async () => {
    const client = makeClient();
    vi.spyOn(globalThis, "fetch").mockResolvedValue(methodResponse("mt_blank", "   \n\t"));

    await expect(client.getMethodClosure("mt_blank")).rejects.toBeInstanceOf(
      EmptyMethodSourceError,
    );
  });

  it("propagates the getMethod 404 for an unknown/foreign-org id (not EmptyMethodSourceError)", async () => {
    const client = makeClient();
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      jsonResponse(404, { code: "not_found", message: "No such method." }),
    );

    const err = await client.getMethodClosure("mt_unknown").catch((e: unknown) => e);

    expect(err).toBeInstanceOf(ApiResponseError);
    expect(err).not.toBeInstanceOf(EmptyMethodSourceError);
    expect((err as ApiResponseError).code).toBe("not_found");
  });
});
