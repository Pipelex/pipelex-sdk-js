import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PipelexApiClient } from "../src/client.js";
import { ApiResponseError } from "../src/errors.js";
import type { PipelineRun } from "../src/product-models.js";

const BASE_URL = "http://localhost:8081";

function makeClient(): PipelexApiClient {
  return new PipelexApiClient({ baseUrl: BASE_URL, apiKey: "test-token" });
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

function emptyResponse(status: number): Response {
  return new Response(null, { status });
}

/** The URL + parsed init of the single fetch call recorded by the spy. */
function lastRequest(spy: ReturnType<typeof vi.spyOn>): {
  url: string;
  method: string;
  body: unknown;
} {
  const [url, init] = spy.mock.calls[0] as [string, RequestInit];
  return {
    url,
    method: String(init.method),
    body: typeof init.body === "string" ? JSON.parse(init.body) : init.body,
  };
}

beforeEach(() => {
  vi.restoreAllMocks();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("user profile", () => {
  it("GETs /v1/me and returns the profile", async () => {
    const client = makeClient();
    const profile = {
      email: "a@b.com",
      user_id: "u1",
      full_name: "A B",
      onboarding_completed_at: null,
    };
    const spy = vi.spyOn(globalThis, "fetch").mockResolvedValue(jsonResponse(200, profile));

    const result = await client.getMe();

    const req = lastRequest(spy);
    expect(req.url).toBe("http://localhost:8081/v1/me");
    expect(req.method).toBe("GET");
    expect(result).toEqual(profile);
  });
});

describe("methods catalog", () => {
  it("GETs /v1/methods and maps the page envelope", async () => {
    const client = makeClient();
    const items = [{ method_id: "m1", name: "M", description: null, created_at: "t" }];
    const spy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(jsonResponse(200, { items, next_cursor: "c1" }));

    const result = await client.listMethods();

    expect(lastRequest(spy).url).toBe("http://localhost:8081/v1/methods");
    // snake_case on the wire -> camelCase on the surface, same as listRuns.
    expect(result).toEqual({ items, nextCursor: "c1" });
  });

  it("forwards q / limit / cursor as query params", async () => {
    const client = makeClient();
    const spy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(jsonResponse(200, { items: [], next_cursor: null }));

    await client.listMethods({ q: "invoice", limit: 10, cursor: "abc" });

    const url = new URL(lastRequest(spy).url);
    expect(url.pathname).toBe("/v1/methods");
    expect(url.searchParams.get("q")).toBe("invoice");
    expect(url.searchParams.get("limit")).toBe("10");
    expect(url.searchParams.get("cursor")).toBe("abc");
  });

  it("sends a bare /v1/methods when no query is given", async () => {
    const client = makeClient();
    const spy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(jsonResponse(200, { items: [], next_cursor: null }));

    await client.listMethods({});

    // No trailing "?" — the URL must stay identical to the no-arg call.
    expect(lastRequest(spy).url).toBe("http://localhost:8081/v1/methods");
  });

  it("forwards an explicit empty q rather than dropping it", async () => {
    // Omission means "did not ask"; an explicit "" is bad input the API should
    // reject. Dropping it would turn a broken search into a silently UNFILTERED
    // query returning the whole catalog, which reads as working.
    const client = makeClient();
    const spy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(jsonResponse(200, { items: [], next_cursor: null }));

    await client.listMethods({ q: "" });

    expect(new URL(lastRequest(spy).url).searchParams.has("q")).toBe(true);
  });

  it("iterateMethods follows the cursor across pages", async () => {
    const client = makeClient();
    const page1 = { items: [{ method_id: "m1", name: "A", created_at: "t" }], next_cursor: "c1" };
    const page2 = { items: [{ method_id: "m2", name: "B", created_at: "t" }], next_cursor: null };
    vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(jsonResponse(200, page1))
      .mockResolvedValueOnce(jsonResponse(200, page2));

    const seen: string[] = [];
    for await (const method of client.iterateMethods()) seen.push(method.method_id);

    expect(seen).toEqual(["m1", "m2"]);
  });

  it("iterateMethods follows a cursor past an EMPTY page", async () => {
    // A filtered page can legitimately be empty WITH a continuation cursor:
    // the platform applies `q` as a post-read filter and walks a bounded
    // number of index pages per request, so a sparse match returns
    // `{items: [], next_cursor: "..."}` meaning "nothing here yet, keep going".
    // Stopping on the empty page silently drops every later match — the exact
    // truncation this pagination work exists to remove.
    const client = makeClient();
    vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(jsonResponse(200, { items: [], next_cursor: "c1" }))
      .mockResolvedValueOnce(jsonResponse(200, { items: [], next_cursor: "c2" }))
      .mockResolvedValueOnce(
        jsonResponse(200, {
          items: [{ method_id: "m1", name: "Needle", created_at: "t" }],
          next_cursor: null,
        }),
      );

    const seen: string[] = [];
    for await (const method of client.iterateMethods({ q: "needle" })) seen.push(method.method_id);

    expect(seen).toEqual(["m1"]);
  });

  it("iterateMethods refuses to page forever against a server that never finishes", async () => {
    // A pure runaway guard, unreachable on real data. It must NOT silently
    // truncate: a caller that asked for every method and got a partial answer
    // with no error would be back to the original bug, one layer up. Note it
    // counts TOTAL pages, not empty ones — an empty page whose cursor advanced
    // is real progress and must never trip a limit (see the test above).
    const client = makeClient();
    // A genuinely FRESH cursor every time — a repeating one would trip the
    // no-progress guard instead, which is a different code path.
    let n = 0;
    vi.spyOn(globalThis, "fetch").mockImplementation(() => {
      n += 1;
      return Promise.resolve(jsonResponse(200, { items: [], next_cursor: `c${n}` }));
    });

    await expect(async () => {
      for await (const _ of client.iterateMethods()) {
        // no-op
      }
    }).rejects.toThrow(/did not terminate/i);
  });

  it("iterateMethods stops when the server stops advancing the cursor", async () => {
    // A server repeating our own cursor has not advanced; yielding first and
    // stopping after would double-count rows for anyone aggregating the stream.
    const client = makeClient();
    const stuck = { items: [{ method_id: "m1", name: "A", created_at: "t" }], next_cursor: "c1" };
    // A fresh Response per call: a single mocked Response body can only be
    // read once, and the guard necessarily makes a SECOND request — detecting
    // a repeated cursor is what that request is for.
    vi.spyOn(globalThis, "fetch").mockImplementation(() =>
      Promise.resolve(jsonResponse(200, stuck)),
    );

    const seen: string[] = [];
    for await (const method of client.iterateMethods()) seen.push(method.method_id);

    expect(seen).toEqual(["m1"]);
  });

  it("GETs /v1/methods/{id} with an encoded id", async () => {
    const client = makeClient();
    const spy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(jsonResponse(200, { method_id: "a/b" }));

    await client.getMethod("a/b");

    expect(lastRequest(spy).url).toBe("http://localhost:8081/v1/methods/a%2Fb");
  });

  it("POSTs /v1/methods with the write body", async () => {
    const client = makeClient();
    const spy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(jsonResponse(200, { method_id: "m1" }));

    await client.createMethod({ name: "M", mthds: "src", input_data: { a: 1 } });

    const req = lastRequest(spy);
    expect(req.method).toBe("POST");
    expect(req.url).toBe("http://localhost:8081/v1/methods");
    expect(req.body).toEqual({ name: "M", mthds: "src", input_data: { a: 1 } });
  });

  it("PUTs /v1/methods/{id} (update/rename)", async () => {
    const client = makeClient();
    const spy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(jsonResponse(200, { method_id: "m1" }));

    await client.updateMethod("m1", { name: "Renamed", mthds: "src" });

    const req = lastRequest(spy);
    expect(req.method).toBe("PUT");
    expect(req.url).toBe("http://localhost:8081/v1/methods/m1");
    expect(req.body).toEqual({ name: "Renamed", mthds: "src" });
  });

  it("DELETEs /v1/methods/{id} and returns the 202 acceptance, not void", async () => {
    const client = makeClient();
    const spy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      jsonResponse(202, {
        method_id: "m1",
        deletion_state: "pending",
        deletion_job_id: "job-1",
      }),
    );

    const accepted = await client.deleteMethod("m/1");

    const req = lastRequest(spy);
    expect(req.method).toBe("DELETE");
    expect(req.url).toBe("http://localhost:8081/v1/methods/m%2F1");
    // The erasure is asynchronous: the caller gets the claim (a job id it can
    // log or correlate), never a "it's gone" signal — completion is the row
    // disappearing from listMethods.
    expect(accepted).toEqual({
      method_id: "m1",
      deletion_state: "pending",
      deletion_job_id: "job-1",
    });
  });

  it("surfaces a second delete of the same method as the platform's 409 conflict", async () => {
    const client = makeClient();
    // The claim is a conditional write, so a double-clicked delete cannot
    // enqueue two cascades over the same runs — the second call errors. Both
    // calls have to go out for that to mean anything: the client holds no
    // memory of an accepted deletion, so it is the platform that refuses the
    // second one.
    const accepted = {
      method_id: "m1",
      deletion_state: "pending",
      deletion_job_id: "job-1",
    };
    const spy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(jsonResponse(202, accepted))
      .mockResolvedValueOnce(
        jsonResponse(409, { code: "conflict", detail: "deletion already pending" }),
      );

    await expect(client.deleteMethod("m1")).resolves.toEqual(accepted);
    const err = await client.deleteMethod("m1").catch((caught: unknown) => caught);

    expect(spy).toHaveBeenCalledTimes(2);
    expect(err).toBeInstanceOf(ApiResponseError);
    expect((err as ApiResponseError).status).toBe(409);
  });

  it("POSTs /v1/methods serializing custom-PipeFunc `python` (MethodFile[] → wire string)", async () => {
    const client = makeClient();
    const spy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(jsonResponse(200, { method_id: "m1" }));

    await client.createMethod({
      name: "M",
      mthds: "src",
      python: [{ name: "helper.py", content: "from pipelex import log\n" }],
    });

    // The typed array is serialized to the catalog string on the wire.
    expect(lastRequest(spy).body).toEqual({
      name: "M",
      mthds: "src",
      python: '[{"name":"helper.py","content":"from pipelex import log\\n"}]',
    });
  });

  it("GETs /v1/methods/{id} parsing the wire `python` string into MethodFile[]", async () => {
    const client = makeClient();
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      jsonResponse(200, {
        method_id: "m1",
        name: "M",
        mthds: "src",
        python: '[{"name":"helper.py","content":"x"}]',
      }),
    );

    const method = await client.getMethod("m1");

    expect(method.python).toEqual([{ name: "helper.py", content: "x" }]);
  });

  it("PUT `python` is three-way: omit preserves, [] clears (''), array sets", async () => {
    const client = makeClient();
    // A fresh Response per call — the client reads the body, single-read across calls.
    const spy = vi
      .spyOn(globalThis, "fetch")
      .mockImplementation(() => Promise.resolve(jsonResponse(200, { method_id: "m1" })));

    // omit → the wire body carries no `python` key (server preserves stored).
    await client.updateMethod("m1", { name: "M", mthds: "src" });
    expect("python" in (lastRequest(spy).body as object)).toBe(false);

    // [] → cleared as the "" sentinel.
    spy.mockClear();
    await client.updateMethod("m1", { name: "M", mthds: "src", python: [] });
    expect((lastRequest(spy).body as { python?: string }).python).toBe("");

    // non-empty → serialized array.
    spy.mockClear();
    await client.updateMethod("m1", {
      name: "M",
      mthds: "src",
      python: [{ name: "a.py", content: "y" }],
    });
    expect((lastRequest(spy).body as { python?: string }).python).toBe(
      '[{"name":"a.py","content":"y"}]',
    );
  });
});

describe("organizations", () => {
  it("GETs /v1/organizations/memberships", async () => {
    const client = makeClient();
    const body = { memberships: [], active_org_feature_flags: ["flag"] };
    const spy = vi.spyOn(globalThis, "fetch").mockResolvedValue(jsonResponse(200, body));

    const result = await client.listMemberships();

    expect(lastRequest(spy).url).toBe("http://localhost:8081/v1/organizations/memberships");
    expect(result).toEqual(body);
  });

  it("POSTs /v1/organizations to create", async () => {
    const client = makeClient();
    const spy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(jsonResponse(200, { org_id: "o1" }));

    await client.createOrganization({ name: "Acme" });

    const req = lastRequest(spy);
    expect(req.method).toBe("POST");
    expect(req.url).toBe("http://localhost:8081/v1/organizations");
    expect(req.body).toEqual({ name: "Acme" });
  });

  it("PATCHes /v1/organizations/{id} to rename", async () => {
    const client = makeClient();
    const spy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(jsonResponse(200, { org_id: "o1" }));

    await client.renameOrganization("o1", { name: "Beta" });

    const req = lastRequest(spy);
    expect(req.method).toBe("PATCH");
    expect(req.url).toBe("http://localhost:8081/v1/organizations/o1");
    expect(req.body).toEqual({ name: "Beta" });
  });
});

describe("billing", () => {
  it("GETs /v1/billing/subscription", async () => {
    const client = makeClient();
    const sub = { plan: "pro", status: "active", can_use_service: true };
    const spy = vi.spyOn(globalThis, "fetch").mockResolvedValue(jsonResponse(200, sub));

    const result = await client.getSubscription();

    expect(lastRequest(spy).url).toBe("http://localhost:8081/v1/billing/subscription");
    expect(result).toEqual(sub);
  });

  it("GETs /v1/billing/plans and /v1/billing/invoices", async () => {
    const client = makeClient();
    // A fresh Response per call — a body is single-read across the two requests.
    const spy = vi
      .spyOn(globalThis, "fetch")
      .mockImplementation(() => Promise.resolve(jsonResponse(200, [])));

    await client.listPlans();
    expect(lastRequest(spy).url).toBe("http://localhost:8081/v1/billing/plans");

    spy.mockClear();
    await client.listInvoices();
    expect(lastRequest(spy).url).toBe("http://localhost:8081/v1/billing/invoices");
  });

  it("POSTs /v1/billing/checkout with the plan", async () => {
    const client = makeClient();
    const spy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(jsonResponse(200, { checkout_url: "https://stripe" }));

    const result = await client.createCheckout({ plan: "pro" });

    const req = lastRequest(spy);
    expect(req.method).toBe("POST");
    expect(req.url).toBe("http://localhost:8081/v1/billing/checkout");
    expect(req.body).toEqual({ plan: "pro" });
    expect(result.checkout_url).toBe("https://stripe");
  });

  it("surfaces a 409 conflict on change-plan via ApiResponseError.code", async () => {
    const client = makeClient();
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      jsonResponse(409, { code: "conflict", message: "No subscription to change." }),
    );

    const err = await client.changePlan({ plan: "pro" }).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(ApiResponseError);
    const e = err as ApiResponseError;
    expect(e.status).toBe(409);
    expect(e.code).toBe("conflict");
    expect(e.serverMessage).toBe("No subscription to change.");
  });

  it("surfaces a 409 conflict on the billing portal", async () => {
    const client = makeClient();
    vi.spyOn(globalThis, "fetch").mockResolvedValue(jsonResponse(409, { code: "conflict" }));

    const err = await client.getBillingPortal().catch((e: unknown) => e);

    expect((err as ApiResponseError).code).toBe("conflict");
  });
});

describe("pipelex api keys", () => {
  it("GETs /v1/pipelex-api-keys (list)", async () => {
    const client = makeClient();
    const spy = vi.spyOn(globalThis, "fetch").mockResolvedValue(jsonResponse(200, { keys: [] }));

    const result = await client.listPipelexApiKeys();

    expect(lastRequest(spy).url).toBe("http://localhost:8081/v1/pipelex-api-keys");
    expect(result).toEqual({ keys: [] });
  });

  it("POSTs /v1/pipelex-api-keys and returns the once-only plaintext", async () => {
    const client = makeClient();
    const created = {
      api_key: "plx_sk_secret",
      id: "k1",
      label: "L",
      prefix: "plx_sk",
      created_at: "t",
    };
    const spy = vi.spyOn(globalThis, "fetch").mockResolvedValue(jsonResponse(201, created));

    const result = await client.createPipelexApiKey({ label: "L" });

    const req = lastRequest(spy);
    expect(req.method).toBe("POST");
    expect(req.body).toEqual({ label: "L" });
    expect(result.api_key).toBe("plx_sk_secret");
  });

  it("surfaces a 409 pipelex_api_key_limit_reached via ApiResponseError.code", async () => {
    const client = makeClient();
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      jsonResponse(409, { code: "pipelex_api_key_limit_reached", message: "Limit reached." }),
    );

    const err = await client.createPipelexApiKey({ label: "L" }).catch((e: unknown) => e);

    expect((err as ApiResponseError).code).toBe("pipelex_api_key_limit_reached");
  });

  it("DELETEs /v1/pipelex-api-keys/{id} with an encoded id", async () => {
    const client = makeClient();
    const spy = vi.spyOn(globalThis, "fetch").mockResolvedValue(emptyResponse(204));

    await client.revokePipelexApiKey("a/b");

    const req = lastRequest(spy);
    expect(req.method).toBe("DELETE");
    expect(req.url).toBe("http://localhost:8081/v1/pipelex-api-keys/a%2Fb");
  });

  it("POSTs /v1/pipelex-api-keys/{id}/rotate with no body", async () => {
    const client = makeClient();
    const spy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(jsonResponse(200, { api_key: "plx_sk_new", id: "k1" }));

    await client.rotatePipelexApiKey("k1");

    const [url, init] = spy.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("http://localhost:8081/v1/pipelex-api-keys/k1/rotate");
    expect(init.method).toBe("POST");
    expect(init.body).toBeUndefined();
  });
});

describe("gateway api key", () => {
  it("POSTs /v1/gateway-api-key and ALWAYS sends a body even when promo_code is null", async () => {
    const client = makeClient();
    const spy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(jsonResponse(200, { gateway_api_key: "gw" }));

    await client.createGatewayApiKey({ promo_code: null });

    const [, init] = spy.mock.calls[0] as [string, RequestInit];
    expect(init.body).toBe(JSON.stringify({ promo_code: null }));
    const headers = init.headers as Record<string, string>;
    expect(headers["Content-Type"]).toBe("application/json");
  });

  it("GETs /v1/gateway-api-key status (null until provisioned)", async () => {
    const client = makeClient();
    const spy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(jsonResponse(200, { gateway_api_key: null }));

    const result = await client.getGatewayApiKey();

    expect(lastRequest(spy).url).toBe("http://localhost:8081/v1/gateway-api-key");
    expect(result.gateway_api_key).toBeNull();
  });
});

describe("onboarding", () => {
  it("POSTs /v1/onboarding/submit and tolerates an empty 2xx body", async () => {
    const client = makeClient();
    const submission = {
      role: "developer" as const,
      use_case: "automate document review for the team",
      process_to_transform: "manual review",
      input_types: ["documents" as const],
      material_domain: "legal",
      current_tool: "none" as const,
      heard_from: "twitter" as const,
    };
    const spy = vi.spyOn(globalThis, "fetch").mockResolvedValue(emptyResponse(204));

    await expect(client.submitOnboarding(submission)).resolves.toBeUndefined();

    const req = lastRequest(spy);
    expect(req.method).toBe("POST");
    expect(req.url).toBe("http://localhost:8081/v1/onboarding/submit");
    expect(req.body).toEqual(submission);
  });
});

describe("storage", () => {
  it("POSTs /v1/resolve-storage-url", async () => {
    const client = makeClient();
    const resolved = { url: "https://s3", expires_at: "t", content_type: "application/pdf" };
    const spy = vi.spyOn(globalThis, "fetch").mockResolvedValue(jsonResponse(200, resolved));

    const result = await client.resolveStorageUrl({ uri: "s3://bucket/key" });

    const req = lastRequest(spy);
    expect(req.url).toBe("http://localhost:8081/v1/resolve-storage-url");
    expect(req.body).toEqual({ uri: "s3://bucket/key" });
    expect(result).toEqual(resolved);
  });

  it("POSTs /v1/upload with the base64 payload", async () => {
    const client = makeClient();
    const spy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(jsonResponse(200, { uri: "s3://x", filename: "f.pdf" }));

    const result = await client.upload({
      filename: "f.pdf",
      data: "Zm9v",
      content_type: "application/pdf",
    });

    const req = lastRequest(spy);
    expect(req.url).toBe("http://localhost:8081/v1/upload");
    expect(req.body).toEqual({ filename: "f.pdf", data: "Zm9v", content_type: "application/pdf" });
    expect(result.uri).toBe("s3://x");
  });
});

describe("runs list / update", () => {
  const RUN_ROW = { pipeline_run_id: "r1", method_id: "m/1", pipe_code: "p", status: "RUNNING" };

  it("GETs /v1/runs?method_id={id} with an encoded query value and unwraps the page", async () => {
    const client = makeClient();
    const spy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(jsonResponse(200, { items: [RUN_ROW], next_cursor: "nxt" }));

    const result = await client.listRuns("m/1");

    expect(lastRequest(spy).url).toBe("http://localhost:8081/v1/runs?method_id=m%2F1");
    expect(result.items).toEqual([RUN_ROW]);
    // snake_case on the wire, camelCase in the SDK surface.
    expect(result.nextCursor).toBe("nxt");
  });

  it("forwards the instant bounds and paging params", async () => {
    const client = makeClient();
    const spy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(jsonResponse(200, { items: [], next_cursor: null }));

    await client.listRuns("m1", {
      createdFrom: "2026-06-02T00:00:00+09:00",
      createdTo: "2026-06-02T23:59:59+09:00",
      limit: 10,
      cursor: "abc",
    });

    const url = new URL(lastRequest(spy).url);
    // These are server-side index KEY CONDITIONS; dropping them turns a bounded
    // page back into "read everything".
    expect(url.searchParams.get("created_from")).toBe("2026-06-02T00:00:00+09:00");
    expect(url.searchParams.get("created_to")).toBe("2026-06-02T23:59:59+09:00");
    expect(url.searchParams.get("limit")).toBe("10");
    expect(url.searchParams.get("cursor")).toBe("abc");
  });

  it("forwards an EXPLICIT empty instant instead of silently dropping the filter", async () => {
    const client = makeClient();
    const spy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(jsonResponse(200, { items: [], next_cursor: null }));

    await client.listRuns("m1", { createdFrom: "" });

    // Dropping it would turn a broken date into an UNFILTERED query that
    // returns every run and looks like it worked. Forwarded, it reaches the
    // API's instant parse and comes back a 400 saying what is wrong.
    const url = new URL(lastRequest(spy).url);
    expect(url.searchParams.has("created_from")).toBe(true);
    expect(url.searchParams.get("created_from")).toBe("");
  });

  it("omits optional params entirely when unset", async () => {
    const client = makeClient();
    const spy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(jsonResponse(200, { items: [], next_cursor: null }));

    await client.listRuns("m1");

    const url = new URL(lastRequest(spy).url);
    // An empty `created_from=` is a 400 from the API's instant parse.
    expect(url.searchParams.has("created_from")).toBe(false);
    expect(url.searchParams.has("cursor")).toBe(false);
  });

  it("iterateRuns follows the cursor to exhaustion", async () => {
    const client = makeClient();
    const spy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(jsonResponse(200, { items: [RUN_ROW], next_cursor: "c1" }))
      .mockResolvedValueOnce(
        jsonResponse(200, { items: [{ ...RUN_ROW, pipeline_run_id: "r2" }], next_cursor: null }),
      );

    const seen: string[] = [];
    for await (const run of client.iterateRuns("m1")) seen.push(run.pipeline_run_id);

    expect(seen).toEqual(["r1", "r2"]);
    expect(spy).toHaveBeenCalledTimes(2);
    // Index the SECOND call explicitly — `lastRequest` reads `calls[0]`.
    const secondUrl = new URL((spy.mock.calls[1] as [string, RequestInit])[0]);
    expect(secondUrl.searchParams.get("cursor")).toBe("c1");
  });

  it("iterateRuns fetches lazily — breaking early stops the requests", async () => {
    const client = makeClient();
    // The property an all-at-once helper cannot have: the caller decides when
    // to stop, so a search that finds its run on page one never pays for page
    // two. A fresh Response per call — a body can only be consumed once.
    const spy = vi
      .spyOn(globalThis, "fetch")
      .mockImplementation(() =>
        Promise.resolve(jsonResponse(200, { items: [RUN_ROW], next_cursor: "more" })),
      );

    for await (const run of client.iterateRuns("m1")) {
      expect(run.pipeline_run_id).toBe("r1");
      break;
    }

    expect(spy).toHaveBeenCalledTimes(1);
  });

  it("iterateRuns terminates on a cursor that never advances", async () => {
    const client = makeClient();
    // The other misbehaving shape: NON-empty pages whose cursor is echoed back
    // unchanged. The empty-page guard does not catch this one, so a caller
    // draining to completion would yield the same page forever. Stopping on a
    // repeated cursor cannot truncate a healthy stream — a real cursor encodes
    // the last row read, so it always moves.
    const spy = vi
      .spyOn(globalThis, "fetch")
      .mockImplementation(() =>
        Promise.resolve(jsonResponse(200, { items: [RUN_ROW], next_cursor: "stuck" })),
      );

    const seen: string[] = [];
    for await (const run of client.iterateRuns("m1")) seen.push(run.pipeline_run_id);

    // Each run is yielded EXACTLY ONCE. The repeat is caught before the second
    // page is emitted, not after — otherwise a caller aggregating the stream
    // (summing cost, counting runs) would double-count the rows it already saw.
    expect(seen).toEqual(["r1"]);
    // The second request still happens: a repeat is only detectable from the
    // response to it.
    expect(spy).toHaveBeenCalledTimes(2);
  });

  it("iterateRuns terminates on a cursor that yields nothing", async () => {
    const client = makeClient();
    // A server claiming another page but returning no rows would spin forever
    // producing nothing. This is a liveness guard, NOT a page cap: it can only
    // fire on an empty page, so it can never truncate a live stream.
    const spy = vi
      .spyOn(globalThis, "fetch")
      .mockImplementation(() =>
        Promise.resolve(jsonResponse(200, { items: [], next_cursor: "always" })),
      );

    const seen: PipelineRun[] = [];
    for await (const run of client.iterateRuns("m1")) seen.push(run);

    expect(seen).toEqual([]);
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it("GETs /v1/runs/{id} for the whole record, bundle included", async () => {
    const client = makeClient();
    const detail = { ...RUN_ROW, mthds_contents: ['domain = "x"'], inputs: { name: "Ada" } };
    const spy = vi.spyOn(globalThis, "fetch").mockResolvedValue(jsonResponse(200, detail));

    const result = await client.getRunDetail("r1");

    expect(lastRequest(spy).url).toBe("http://localhost:8081/v1/runs/r1");
    expect(result.mthds_contents).toEqual(['domain = "x"']);
  });

  it("PUTs /v1/runs/{id} and tolerates an empty body", async () => {
    const client = makeClient();
    const spy = vi.spyOn(globalThis, "fetch").mockResolvedValue(emptyResponse(204));

    await expect(
      client.updateRun("r1", { status: "COMPLETED", result_url: "https://x" }),
    ).resolves.toBeUndefined();

    const req = lastRequest(spy);
    expect(req.method).toBe("PUT");
    expect(req.url).toBe("http://localhost:8081/v1/runs/r1");
    expect(req.body).toEqual({ status: "COMPLETED", result_url: "https://x" });
  });
});

describe("product transport", () => {
  it("attaches the bearer token to product requests", async () => {
    const client = makeClient();
    const spy = vi.spyOn(globalThis, "fetch").mockResolvedValue(jsonResponse(200, {}));

    await client.getMe();

    const [, init] = spy.mock.calls[0] as [string, RequestInit];
    const headers = init.headers as Record<string, string>;
    expect(headers["Authorization"]).toBe("Bearer test-token");
  });
});
