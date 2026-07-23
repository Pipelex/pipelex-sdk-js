import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PipelexApiClient } from "../src/client.js";
import { ApiResponseError } from "../src/errors.js";

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
  it("GETs /v1/methods (list)", async () => {
    const client = makeClient();
    const methods = [
      {
        method_id: "m1",
        org_id: "o1",
        created_by_user_id: "u1",
        name: "M",
        mthds: "...",
        created_at: "t",
        updated_at: "t",
      },
    ];
    const spy = vi.spyOn(globalThis, "fetch").mockResolvedValue(jsonResponse(200, methods));

    const result = await client.listMethods();

    expect(lastRequest(spy).url).toBe("http://localhost:8081/v1/methods");
    expect(result).toEqual(methods);
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
  it("GETs /v1/runs?method_id={id} with an encoded query value", async () => {
    const client = makeClient();
    const runs = [{ pipeline_run_id: "r1", method_id: "m/1", pipe_code: "p", status: "RUNNING" }];
    const spy = vi.spyOn(globalThis, "fetch").mockResolvedValue(jsonResponse(200, runs));

    const result = await client.listRuns("m/1");

    expect(lastRequest(spy).url).toBe("http://localhost:8081/v1/runs?method_id=m%2F1");
    expect(result).toEqual(runs);
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
