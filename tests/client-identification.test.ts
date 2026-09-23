/**
 * The `User-Agent` the client sends, per the workspace spec
 * `docs/specs/client-identification.md`: on every request to the API (both fetch
 * helpers), with `appInfo` in front, absent in a browser, and never on the
 * third-party fetch of a presigned object-store link.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PipelexApiClient } from "../src/client.js";
import { HOOK_APP_INFO, createHookClient } from "../src/hooks/validate-client.js";
import { SDK_VERSION } from "../src/version.js";

const BASE_URL = "http://localhost:8081";
const RUNTIME = `node/${process.versions.node} (${process.platform}; ${process.arch})`;
const LIBRARY_UA = `pipelex-sdk-js/${SDK_VERSION} ${RUNTIME}`;

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

/** The headers the `index`-th request a spied fetch received carried. */
function headersOf(spy: ReturnType<typeof vi.spyOn>, index = 0): Record<string, string> {
  const init = spy.mock.calls[index]![1] as { headers?: Record<string, string> };
  return init.headers ?? {};
}

beforeEach(() => {
  vi.restoreAllMocks();
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe("PipelexApiClient User-Agent", () => {
  it("sends the library's header on a protocol route (requestRaw)", async () => {
    const client = new PipelexApiClient({ baseUrl: BASE_URL, apiKey: "t" });
    const spy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(jsonResponse(200, { pipeline_run_id: "x" }));
    await client.execute({ pipe_code: "p" });
    expect(headersOf(spy)["User-Agent"]).toBe(LIBRARY_UA);
    expect(headersOf(spy)["Authorization"]).toBe("Bearer t");
  });

  it("sends it on a product route (requestProduct → requestRaw)", async () => {
    const client = new PipelexApiClient({ baseUrl: BASE_URL, apiKey: "t" });
    const spy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(jsonResponse(200, { id: "usr_1", email: "a@b.c" }));
    await client.getMe();
    expect(headersOf(spy)["User-Agent"]).toBe(LIBRARY_UA);
  });

  it("sends it on the origin-level health probe (requestJson)", async () => {
    const client = new PipelexApiClient({ baseUrl: BASE_URL });
    const spy = vi.spyOn(globalThis, "fetch").mockResolvedValue(jsonResponse(200, { ok: true }));
    await client.health();
    expect(spy.mock.calls[0]![0]).toBe(`${BASE_URL}/health`);
    expect(headersOf(spy)["User-Agent"]).toBe(LIBRARY_UA);
  });

  it("puts appInfo before the SDK's own token", async () => {
    const client = new PipelexApiClient({
      baseUrl: BASE_URL,
      appInfo: { name: "acme-invoicer", version: "1.4.0", details: ["batch"] },
    });
    const spy = vi.spyOn(globalThis, "fetch").mockResolvedValue(jsonResponse(200, { ok: true }));
    await client.health();
    expect(headersOf(spy)["User-Agent"]).toBe(`acme-invoicer/1.4.0 (batch) ${LIBRARY_UA}`);
  });

  it("refuses an invalid appInfo at construction", () => {
    expect(
      () => new PipelexApiClient({ baseUrl: BASE_URL, appInfo: { name: "two words" } }),
    ).toThrow(TypeError);
    expect(
      () => new PipelexApiClient({ baseUrl: BASE_URL, appInfo: { name: "a", version: "1 0" } }),
    ).toThrow(TypeError);
  });

  it("sets no User-Agent in a browser", async () => {
    vi.stubGlobal("window", { document: {} });
    const client = new PipelexApiClient({ baseUrl: BASE_URL, appInfo: { name: "acme" } });
    const spy = vi
      .spyOn(globalThis, "fetch")
      .mockImplementation(() => Promise.resolve(jsonResponse(200, { ok: true })));
    await client.health();
    await client.getMe();
    expect(headersOf(spy, 0)).not.toHaveProperty("User-Agent");
    expect(headersOf(spy, 1)).not.toHaveProperty("User-Agent");
  });

  it("leaves the third-party fetch of a presigned link without headers", async () => {
    const uri = "pipelex-storage://org/runs/01JRUN/outputs/illustration.png";
    const store = "https://store.example/object?sig=abc";
    const client = new PipelexApiClient({ baseUrl: BASE_URL, apiKey: "t" });
    const spy = vi.spyOn(globalThis, "fetch").mockImplementation((input) => {
      if (String(input).startsWith(BASE_URL)) {
        return Promise.resolve(
          jsonResponse(200, {
            items: [
              {
                uri,
                url: store,
                expires_at: new Date(Date.now() + 900_000).toISOString(),
                content_type: "image/png",
                error: null,
              },
            ],
          }),
        );
      }
      return Promise.resolve(new Response(new Uint8Array([1, 2, 3]), { status: 200 }));
    });
    const response = await client.fetchArtifact(uri);
    await response.arrayBuffer();
    expect(spy).toHaveBeenCalledTimes(2);
    expect(headersOf(spy, 0)["User-Agent"]).toBe(LIBRARY_UA);
    expect(String(spy.mock.calls[1]![0])).toBe(store);
    const storeInit = spy.mock.calls[1]![1] as RequestInit;
    expect(storeInit.headers).toBeUndefined();
  });
});

describe("the mthds-check hook's identity", () => {
  it("names itself pipelex-mthds-check at the SDK's version", () => {
    expect(HOOK_APP_INFO).toEqual({ name: "pipelex-mthds-check", version: SDK_VERSION });
  });

  it("sends its token in front of the SDK's on validate", async () => {
    vi.stubEnv("PIPELEX_API_KEY", "hook-key");
    vi.stubEnv("PIPELEX_BASE_URL", BASE_URL);
    const client = createHookClient();
    const spy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(jsonResponse(200, { is_valid: true, is_runnable: true }));
    await client
      .validateFiles([{ content: "domain = 'x'" }], { allowSignatures: true })
      .catch(() => undefined);
    expect(spy.mock.calls[0]![0]).toBe(`${BASE_URL}/v1/validate`);
    expect(headersOf(spy)["User-Agent"]).toBe(
      `pipelex-mthds-check/${SDK_VERSION} pipelex-sdk-js/${SDK_VERSION} ${RUNTIME}`,
    );
    expect(headersOf(spy)["Authorization"]).toBe("Bearer hook-key");
  });
});
