/**
 * E2E suite for the artifact round trip — exercised against a LIVE hosted platform
 * (no fetch mocks). Run with `make test-e2e` (or `npm run test:e2e`) against a
 * platform that serves upload, the durable run lifecycle and the bulk resolve route
 * (`POST /v1/resolve-storage-url/bulk`), with `PIPELEX_API_KEY` set for it:
 *
 *     PIPELEX_E2E_BASE_URL=https://api-dev.pipelex.com PIPELEX_API_KEY=plx_sk_… npm run test:e2e
 *
 * What the unit suite cannot prove: that the wire shapes the SDK composes — the
 * bulk request, the per-item answer, the presigned link the store actually honours,
 * the working-memory echo of an uploaded input — are the ones a real platform
 * produces. Every mock agrees with the client about the field names; only a live
 * exchange settles whether the platform does.
 *
 * The leg is the design's: `prepareInputs` a small file, run a pass-through with no
 * inference, `downloadArtifacts` over `working_memory`, and read the bytes back
 * equal. A bare runner cannot run it (no upload, no run store, no resolve route) and
 * fails it honestly rather than skipping.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { PipelexApiClient } from "../../src/client.js";
import { artifactFilename, collectArtifacts } from "../../src/artifacts.js";

const BASE_URL = process.env.PIPELEX_E2E_BASE_URL ?? "http://localhost:8081";

/** One domain, one main pipe, a Document input beside the Text it echoes — no inference. */
const PASS_THROUGH_BUNDLE = `domain = "smoke_artifacts"
main_pipe = "echo_note"

[pipe.echo_note]
type = "PipeCompose"
description = "Echo the note beside a document, with no inference"
inputs = { doc = "Document", note = "Text" }
output = "Text"
template = "$note"
`;

/** A minimal PDF, with a few bytes of its own so a swapped file could not pass. Nothing in the run reads it. */
const PDF_BYTES = new TextEncoder().encode(
  "%PDF-1.4\n1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj\n2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj\n" +
    "3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 200 200]>>endobj\n" +
    `% nonce ${Date.now().toString(36)}\ntrailer<</Root 1 0 R>>\n%%EOF\n`,
);

describe("the artifact round trip against a live platform", () => {
  let client: PipelexApiClient;
  let workDir: string;

  beforeAll(async () => {
    client = new PipelexApiClient({ baseUrl: BASE_URL });
    workDir = await mkdtemp(join(tmpdir(), "pipelex-sdk-artifacts-e2e-"));
  });

  afterAll(async () => {
    await rm(workDir, { recursive: true, force: true });
  });

  it("brings an uploaded input back down byte for byte through working_memory", async () => {
    const source = join(workDir, "brief.pdf");
    await writeFile(source, PDF_BYTES);

    // Up: the Document position is uploaded and rewritten to its storage reference.
    const prepared = await client.prepareInputs({
      files: [{ content: PASS_THROUGH_BUNDLE, source: "smoke_artifacts.mthds" }],
      inputs: { doc: source, note: "round trip" },
    });
    expect(prepared.uploads).toHaveLength(1);
    const uploaded = prepared.uploads[0]!.uri;
    expect(collectArtifacts(prepared.inputs)).toEqual([uploaded]);

    // Across: a pass-through run echoes the input in its working memory.
    const results = await client.startAndWaitForResult({
      mthds_contents: [PASS_THROUGH_BUNDLE],
      pipe_code: "smoke_artifacts.echo_note",
      inputs: prepared.inputs,
    });
    expect(results.main_stuff).toEqual({ text: "round trip" });

    // Down: by run id, over working_memory, every link minted fresh.
    const verdict = await client.downloadArtifacts({
      run_id: results.pipeline_run_id,
      dir: join(workDir, "out"),
      scope: "working_memory",
      // The local stack's object store hands out plain http links; a hosted one never does.
      allowHttp: BASE_URL.startsWith("http://"),
    });

    expect(verdict.scope).toBe("working_memory");
    expect(verdict.all_saved).toBe(true);
    expect(verdict.aborted).toBeUndefined();
    const echoed = verdict.artifacts.find((artifact) => artifact.uri === uploaded);
    expect(echoed).toBeDefined();
    expect(echoed!.error).toBeNull();
    expect(echoed!.content_type).toBe("application/pdf");
    expect(echoed!.size).toBe(PDF_BYTES.byteLength);
    // The file is named after the working-memory field the echoed input sits in.
    expect(echoed!.found_at[0]).toMatch(/^\$\./);
    expect(basename(echoed!.path!)).toBe(
      artifactFilename(echoed!, echoed!.content_type, "working_memory"),
    );
    expect(verdict.saved_paths).toContain(echoed!.path);
    expect(new Uint8Array(await readFile(echoed!.path!))).toEqual(PDF_BYTES);
  }, 120_000);

  it("resolves the uploaded reference through the bulk route and refuses a malformed one as a value", async () => {
    const record = await client.uploadFile(PDF_BYTES, {
      filename: "probe.pdf",
      contentType: "application/pdf",
    });

    const resolved = await client.resolveArtifacts([record.uri, "pipelex-storage://"]);

    expect(resolved).toHaveLength(2);
    expect(resolved[0]!.uri).toBe(record.uri);
    expect(resolved[0]!.error).toBeNull();
    expect(resolved[0]!.url).toMatch(/^https?:\/\//);
    expect(Date.parse(resolved[0]!.expires_at!)).toBeGreaterThan(Date.now());
    expect(resolved[1]!.error).not.toBeNull();
    expect(resolved[1]!.url).toBeNull();

    // The link the platform minted is honoured by the store: the bytes come back.
    const response = await client.fetchArtifact(record.uri, {
      allowHttp: BASE_URL.startsWith("http://"),
    });
    expect(response.status).toBe(200);
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(PDF_BYTES);
  });
});
