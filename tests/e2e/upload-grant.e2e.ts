/**
 * E2E suite for the upload grant — exercised against a LIVE hosted platform (no fetch
 * mocks). Run with `make test-e2e` (or `npm run test:e2e`) against a platform that
 * serves `POST /v1/upload/grant` (platform >= 0.20.0) with the app bucket's CORS rule,
 * with `PIPELEX_API_KEY` set for it:
 *
 *     PIPELEX_E2E_BASE_URL=https://api-dev.pipelex.com PIPELEX_API_KEY=plx_sk_… npm run test:e2e
 *
 * What the unit suite cannot prove: that the PUT `uploadWithGrant` composes is the one
 * S3 accepts for the grant the platform signed — the header names, the body setting a
 * `Content-Length` that matches the signed one — and that S3's refusals carry the codes
 * the error mapping reads. Every mock agrees with the helper; only the live store
 * settles whether S3 does. It runs in Node, whose `fetch` sends no preflight, so the
 * bucket's CORS rule is proven by a hosted page, not here.
 *
 * A bare runner cannot run it (the grant is a platform route) and fails it honestly
 * rather than skipping.
 */

import { beforeAll, describe, expect, it } from "vitest";
import { PipelexApiClient } from "../../src/client.js";
import { ApiResponseError, RejectedAssetError } from "../../src/errors.js";
import { uploadWithGrant } from "../../src/upload-grant.js";

const BASE_URL = process.env.PIPELEX_E2E_BASE_URL ?? "http://localhost:8081";

/** A minimal PDF with a nonce of its own, so a stale object could not pass for this one. */
function pdfBytes(): Uint8Array<ArrayBuffer> {
  return new TextEncoder().encode(
    "%PDF-1.4\n1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj\n2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj\n" +
      "3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 200 200]>>endobj\n" +
      `% nonce ${Date.now().toString(36)}${Math.random().toString(36).slice(2)}\ntrailer<</Root 1 0 R>>\n%%EOF\n`,
  );
}

function pdfFile(bytes: Uint8Array<ArrayBuffer>, name = "grant-e2e.pdf"): File {
  return new File([bytes], name, { type: "application/pdf" });
}

describe("the upload grant against a live platform", () => {
  let client: PipelexApiClient;

  beforeAll(() => {
    client = new PipelexApiClient({ baseUrl: BASE_URL });
  });

  it("uploads through a grant, and the reference resolves to the same bytes", async () => {
    const bytes = pdfBytes();
    const file = pdfFile(bytes);

    const grant = await client.requestUploadGrant({
      filename: file.name,
      content_type: file.type,
      size: file.size,
    });

    expect(grant.uri).toMatch(/^pipelex-storage:\/\/.+\.pdf$/);
    expect(grant.url).toMatch(/^https:\/\//);
    expect(grant.headers["If-None-Match"]).toBe("*");
    expect(grant.headers["Content-Type"]).toBe("application/pdf");
    expect(Date.parse(grant.expires_at)).toBeGreaterThan(Date.now());
    expect(grant.max_bytes).toBeGreaterThanOrEqual(file.size);

    const stored = await uploadWithGrant(grant, file);
    expect(stored).toEqual({ uri: grant.uri });

    const resolved = await client.resolveStorageUrl({ uri: stored.uri });
    expect(resolved.content_type).toBe("application/pdf");
    const response = await client.fetchArtifact(stored.uri);
    expect(response.status).toBe(200);
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(bytes);
  });

  it("refuses a second upload with the same grant as a rejected asset (412)", async () => {
    const file = pdfFile(pdfBytes());
    const grant = await client.requestUploadGrant({
      filename: file.name,
      content_type: file.type,
      size: file.size,
    });
    await uploadWithGrant(grant, file);

    const error = await uploadWithGrant(grant, file).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(RejectedAssetError);
    expect((error as RejectedAssetError).status).toBe(412);
    expect((error as RejectedAssetError).code).toBe("grant_used");
    expect((error as RejectedAssetError).message).toContain("PreconditionFailed");
  });

  it("refuses a file of another size than the grant signed as a rejected asset (403)", async () => {
    const bytes = pdfBytes();
    const grant = await client.requestUploadGrant({
      filename: "grant-e2e.pdf",
      content_type: "application/pdf",
      size: bytes.byteLength,
    });
    const longer = new Uint8Array(bytes.byteLength + 1);
    longer.set(bytes);

    const error = await uploadWithGrant(grant, pdfFile(longer)).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(RejectedAssetError);
    expect((error as RejectedAssetError).status).toBe(403);
    expect((error as RejectedAssetError).code).toBe("signature_mismatch");
    expect((error as RejectedAssetError).message).toContain("SignatureDoesNotMatch");
  });

  it("refuses a declared size over the cap before any grant is minted (413)", async () => {
    const probe = await client.requestUploadGrant({ filename: "probe.pdf", size: 1 });

    const error = await client
      .requestUploadGrant({ filename: "too-big.pdf", size: probe.max_bytes + 1 })
      .catch((e: unknown) => e);

    expect(error).toBeInstanceOf(ApiResponseError);
    expect((error as ApiResponseError).status).toBe(413);
    expect((error as ApiResponseError).code).toBe("payload_too_large");
  });
});
