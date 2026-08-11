/**
 * `prepareInputs` — signature-driven input preparation. Cases derive from the
 * shared behavior matrix (`wip/upload/behavior-matrix.md`): file-bearing positions
 * are found from the explicit template's canonical content shape (a `{url:…}`
 * dict), assets are uploaded and rewritten to `pipelex-storage://` in `url`,
 * http(s)/storage references pass through, dedup keys on source identity, and the
 * call is copy-on-write.
 *
 * The fake client returns a canned explicit template from `buildInputs` and a
 * counting `upload`, so no server or filesystem is involved (except the one path
 * case, which uses a real temp file).
 */

import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { prepareInputs } from "../src/prepare-inputs.js";
import type { PrepareCapableClient, PrepareInputsRequest } from "../src/prepare-inputs.js";
import {
  InputPreparationError,
  RejectedAssetError,
  ApiResponseError,
  EmptyMethodSourceError,
} from "../src/errors.js";
import type { BuildInputsResponse, MthdsFileItem } from "../src/models.js";

/** Build an explicit-template envelope entry. */
function entry(concept: string, content: unknown): { concept: string; content: unknown } {
  return { concept, content };
}

interface FakeClient extends PrepareCapableClient {
  uploadCalls: { filename: string; data: string; content_type: string }[];
  getMethodClosureCalls: string[];
}

const FILES = [{ content: 'domain = "demo"' }];

/** Fake client: `buildInputs` returns the given envelope template; `upload` counts calls. */
function makeClient(
  template: Record<string, unknown>,
  overrides: {
    report?: BuildInputsResponse;
    uploadError?: unknown;
    closure?: MthdsFileItem[];
    closureError?: unknown;
  } = {},
): FakeClient {
  const uploadCalls: { filename: string; data: string; content_type: string }[] = [];
  const getMethodClosureCalls: string[] = [];
  let counter = 0;
  return {
    uploadCalls,
    getMethodClosureCalls,
    async buildInputs() {
      return (
        overrides.report ?? {
          is_valid: true,
          pipe_ref: "demo.main",
          message: "ok",
          format: "json",
          explicit: true,
          inputs: template,
        }
      );
    },
    async getMethodClosure(methodId) {
      getMethodClosureCalls.push(methodId);
      if (overrides.closureError) throw overrides.closureError;
      return overrides.closure ?? FILES;
    },
    async upload(input) {
      if (overrides.uploadError) throw overrides.uploadError;
      counter += 1;
      uploadCalls.push(input);
      return { uri: `pipelex-storage://user/assets/${counter}.bin`, filename: input.filename };
    },
  };
}

describe("prepareInputs", () => {
  const tempDirs: string[] = [];
  afterEach(async () => {
    await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
  });

  it("uploads a top-level Image scalar given as bytes and rewrites url to a storage URI", async () => {
    const client = makeClient({ photo: entry("demo.Photo", { url: "https://mock/p.png" }) });

    const prepared = await prepareInputs(client, {
      files: FILES,
      inputs: { photo: new Uint8Array([1, 2, 3]) },
    });

    expect(prepared.inputs).toEqual({ photo: { url: "pipelex-storage://user/assets/1.bin" } });
    expect(prepared.uploads).toHaveLength(1);
    expect(prepared.uploads[0]?.uri).toBe("pipelex-storage://user/assets/1.bin");
    expect(client.uploadCalls).toHaveLength(1);
  });

  it("passes an http(s) URL through unchanged with no upload", async () => {
    const client = makeClient({ photo: entry("demo.Photo", { url: "https://mock/p.png" }) });

    const prepared = await prepareInputs(client, {
      files: FILES,
      inputs: { photo: "https://example.com/real.png" },
    });

    expect(prepared.inputs).toEqual({ photo: { url: "https://example.com/real.png" } });
    expect(prepared.uploads).toHaveLength(0);
    expect(client.uploadCalls).toHaveLength(0);
  });

  it("passes an existing pipelex-storage:// URI through unchanged", async () => {
    const client = makeClient({ photo: entry("demo.Photo", { url: "https://mock/p.png" }) });

    const prepared = await prepareInputs(client, {
      files: FILES,
      inputs: { photo: "pipelex-storage://user/assets/already.png" },
    });

    expect(prepared.inputs).toEqual({
      photo: { url: "pipelex-storage://user/assets/already.png" },
    });
    expect(prepared.uploads).toHaveLength(0);
  });

  it("decodes and uploads a data: URL", async () => {
    const client = makeClient({ photo: entry("demo.Photo", { url: "https://mock/p.png" }) });

    const prepared = await prepareInputs(client, {
      files: FILES,
      inputs: { photo: "data:image/png;base64,AQIDBA==" },
    });

    expect(prepared.inputs).toEqual({ photo: { url: "pipelex-storage://user/assets/1.bin" } });
    expect(client.uploadCalls).toHaveLength(1);
    expect(client.uploadCalls[0]?.content_type).toBe("image/png");
    expect(client.uploadCalls[0]?.data).toBe("AQIDBA==");
  });

  it("uploads each element of a declared-multiple Document input", async () => {
    const client = makeClient({ exhibits: entry("demo.Exhibit", [{ url: "https://mock/d.pdf" }]) });

    const prepared = await prepareInputs(client, {
      files: FILES,
      inputs: { exhibits: [new Uint8Array([1]), new Uint8Array([2])] },
    });

    expect(prepared.inputs).toEqual({
      exhibits: [
        { url: "pipelex-storage://user/assets/1.bin" },
        { url: "pipelex-storage://user/assets/2.bin" },
      ],
    });
    expect(prepared.uploads).toHaveLength(2);
  });

  it("leaves a Text input untouched even when it looks like a path", async () => {
    const client = makeClient({ question: entry("demo.Question", { text: "text_value" }) });

    const prepared = await prepareInputs(client, {
      files: FILES,
      inputs: { question: "notes/summary.txt" },
    });

    expect(prepared.inputs).toEqual({ question: "notes/summary.txt" });
    expect(client.uploadCalls).toHaveLength(0);
  });

  it("uploads only the nested Image field of a structured input, leaving siblings untouched", async () => {
    const client = makeClient({
      dossier: entry("demo.Dossier", {
        title: "title_value",
        cover: { url: "https://mock/c.png", mime_type: "image/png" },
      }),
    });

    const prepared = await prepareInputs(client, {
      files: FILES,
      inputs: { dossier: { title: "Q3 report", cover: new Uint8Array([7, 7]) } },
    });

    expect(prepared.inputs).toEqual({
      dossier: { title: "Q3 report", cover: { url: "pipelex-storage://user/assets/1.bin" } },
    });
    expect(prepared.uploads).toHaveLength(1);
  });

  it("does not path-interpret a bare string at a Dynamic input", async () => {
    const client = makeClient({ freeform: entry("native.Anything", { whatever: "value" }) });

    const prepared = await prepareInputs(client, {
      files: FILES,
      inputs: { freeform: "just some text that resembles/a/path" },
    });

    expect(prepared.inputs).toEqual({ freeform: "just some text that resembles/a/path" });
    expect(client.uploadCalls).toHaveLength(0);
  });

  it("uploads a canonical Image dict nested inside a Dynamic input", async () => {
    const client = makeClient({
      data: entry("native.Composite", { text: "t", images: [{ url: "https://mock/i.png" }] }),
    });

    const prepared = await prepareInputs(client, {
      files: FILES,
      inputs: { data: { text: "hi", images: [new Uint8Array([5])] } },
    });

    expect(prepared.inputs).toEqual({
      data: { text: "hi", images: [{ url: "pipelex-storage://user/assets/1.bin" }] },
    });
    expect(prepared.uploads).toHaveLength(1);
  });

  it("dedups by source identity: the same bytes object uploads once", async () => {
    const client = makeClient({ exhibits: entry("demo.Exhibit", [{ url: "https://mock/d.pdf" }]) });
    const shared = new Uint8Array([9, 9, 9]);

    const prepared = await prepareInputs(client, {
      files: FILES,
      inputs: { exhibits: [shared, shared] },
    });

    expect(client.uploadCalls).toHaveLength(1);
    const [first, second] = prepared.inputs.exhibits as { url: string }[];
    expect(first.url).toBe(second.url);
  });

  it("is copy-on-write: the caller's inputs object is not mutated", async () => {
    const client = makeClient({ photo: entry("demo.Photo", { url: "https://mock/p.png" }) });
    const original = { photo: new Uint8Array([1, 2, 3]) };

    await prepareInputs(client, { files: FILES, inputs: original });

    expect(original.photo).toBeInstanceOf(Uint8Array);
  });

  it("passes through an input not present in the declared template", async () => {
    const client = makeClient({ photo: entry("demo.Photo", { url: "https://mock/p.png" }) });

    const prepared = await prepareInputs(client, {
      files: FILES,
      inputs: { photo: "https://example.com/p.png", stray: "left alone" },
    });

    expect(prepared.inputs.stray).toBe("left alone");
  });

  it("uploads a real local path at a top-level Image input (Node path branch)", async () => {
    const dir = await mkdtemp(join(tmpdir(), "plx-prepare-"));
    tempDirs.push(dir);
    const path = join(dir, "shot.png");
    await writeFile(path, new Uint8Array([1, 2, 3, 4]));
    const client = makeClient({ photo: entry("demo.Photo", { url: "https://mock/p.png" }) });

    const prepared = await prepareInputs(client, { files: FILES, inputs: { photo: path } });

    expect(prepared.inputs).toEqual({ photo: { url: "pipelex-storage://user/assets/1.bin" } });
    expect(client.uploadCalls[0]?.content_type).toBe("image/png");
  });

  it("throws InputPreparationError for an unrecognized value at a file position", async () => {
    const client = makeClient({ photo: entry("demo.Photo", { url: "https://mock/p.png" }) });

    // A plain object that is neither a canonical `{url}` content nor bytes — a realistic
    // caller typo — must surface as a typed error, not a raw TypeError from byte extraction.
    await expect(
      prepareInputs(client, {
        files: FILES,
        inputs: { photo: { mimeType: "image/png", bytes: [1, 2, 3] } },
      }),
    ).rejects.toBeInstanceOf(InputPreparationError);
    expect(client.uploadCalls).toHaveLength(0);
  });

  it("throws InputPreparationError for a malformed data URL instead of a raw decode error", async () => {
    const client = makeClient({ photo: entry("demo.Photo", { url: "https://mock/p.png" }) });

    // Malformed percent-encoding — `decodeURIComponent` would otherwise throw a raw URIError
    // that escapes the typed preparation-error contract.
    await expect(
      prepareInputs(client, { files: FILES, inputs: { photo: "data:text/plain,%ZZ" } }),
    ).rejects.toBeInstanceOf(InputPreparationError);
    expect(client.uploadCalls).toHaveLength(0);
  });

  it("throws InputPreparationError for a malformed base64 data URL instead of silently uploading truncated bytes", async () => {
    const client = makeClient({ photo: entry("demo.Photo", { url: "https://mock/p.png" }) });

    // Node's `Buffer.from(x, "base64")` is lenient: it silently drops invalid characters and
    // returns truncated/empty bytes, so a malformed base64 payload would upload corrupt content
    // instead of failing the preparation contract. Both runtimes must reject it via `atob`.
    await expect(
      prepareInputs(client, { files: FILES, inputs: { photo: "data:image/png;base64,%%%%" } }),
    ).rejects.toBeInstanceOf(InputPreparationError);
    expect(client.uploadCalls).toHaveLength(0);
  });

  it("throws InputPreparationError when the method signature does not resolve", async () => {
    const client = makeClient(
      {},
      {
        report: {
          is_valid: false,
          message: "closure did not validate",
          validation_errors: [{ category: "blueprint_validation", message: "unknown pipe type" }],
        },
      },
    );

    await expect(
      prepareInputs(client, { files: FILES, inputs: { photo: new Uint8Array([1]) } }),
    ).rejects.toBeInstanceOf(InputPreparationError);
  });

  it("surfaces a rejected-asset error before returning (413 during upload)", async () => {
    const client = makeClient(
      { photo: entry("demo.Photo", { url: "https://mock/p.png" }) },
      {
        uploadError: new ApiResponseError(
          "HTTP 413",
          "https://api.pipelex.com/v1/upload",
          413,
          "Payload Too Large",
          "",
          undefined,
          "too big",
          undefined,
          undefined,
        ),
      },
    );

    await expect(
      prepareInputs(client, { files: FILES, inputs: { photo: new Uint8Array([1]) } }),
    ).rejects.toBeInstanceOf(RejectedAssetError);
  });
});

describe("prepareInputs with the explicit { concept, content } envelope", () => {
  // The caller may hand back the SAME shape `buildInputs({ explicit: true })` produces:
  // a `{ concept, content }` envelope per input. Preparation unwraps `.content`, runs the
  // compact walk, then re-wraps — preserving the concept annotation for the run.

  it("uploads an envelope Image whose content is bytes and re-wraps the rewritten content", async () => {
    const client = makeClient({ photo: entry("demo.Photo", { url: "https://mock/p.png" }) });

    const prepared = await prepareInputs(client, {
      files: FILES,
      inputs: { photo: { concept: "demo.Photo", content: new Uint8Array([1, 2, 3]) } },
    });

    expect(prepared.inputs).toEqual({
      photo: { concept: "demo.Photo", content: { url: "pipelex-storage://user/assets/1.bin" } },
    });
    expect(prepared.uploads).toHaveLength(1);
    expect(client.uploadCalls).toHaveLength(1);
  });

  it("passes an envelope http(s) URL through unchanged with no upload", async () => {
    const client = makeClient({ photo: entry("demo.Photo", { url: "https://mock/p.png" }) });

    const prepared = await prepareInputs(client, {
      files: FILES,
      inputs: {
        photo: { concept: "demo.Photo", content: { url: "https://example.com/real.png" } },
      },
    });

    expect(prepared.inputs).toEqual({
      photo: { concept: "demo.Photo", content: { url: "https://example.com/real.png" } },
    });
    expect(prepared.uploads).toHaveLength(0);
    expect(client.uploadCalls).toHaveLength(0);
  });

  it("passes an envelope with an existing pipelex-storage:// URI through unchanged", async () => {
    const client = makeClient({ photo: entry("demo.Photo", { url: "https://mock/p.png" }) });

    const prepared = await prepareInputs(client, {
      files: FILES,
      inputs: {
        photo: {
          concept: "demo.Photo",
          content: { url: "pipelex-storage://user/assets/already.png" },
        },
      },
    });

    expect(prepared.inputs).toEqual({
      photo: {
        concept: "demo.Photo",
        content: { url: "pipelex-storage://user/assets/already.png" },
      },
    });
    expect(prepared.uploads).toHaveLength(0);
  });

  it("decodes and uploads an envelope data: URL", async () => {
    const client = makeClient({ photo: entry("demo.Photo", { url: "https://mock/p.png" }) });

    const prepared = await prepareInputs(client, {
      files: FILES,
      inputs: { photo: { concept: "demo.Photo", content: "data:image/png;base64,AQIDBA==" } },
    });

    expect(prepared.inputs).toEqual({
      photo: { concept: "demo.Photo", content: { url: "pipelex-storage://user/assets/1.bin" } },
    });
    expect(client.uploadCalls).toHaveLength(1);
    expect(client.uploadCalls[0]?.content_type).toBe("image/png");
  });

  it("leaves an envelope Text input untouched — no upload", async () => {
    const client = makeClient({ question: entry("demo.Question", { text: "text_value" }) });

    const prepared = await prepareInputs(client, {
      files: FILES,
      inputs: { question: { concept: "native.Text", content: "What is in the photo?" } },
    });

    expect(prepared.inputs).toEqual({
      question: { concept: "native.Text", content: "What is in the photo?" },
    });
    expect(client.uploadCalls).toHaveLength(0);
  });

  it("uploads each element of an envelope list-of-Documents and re-wraps the list", async () => {
    const client = makeClient({ exhibits: entry("demo.Exhibit", [{ url: "https://mock/d.pdf" }]) });

    const prepared = await prepareInputs(client, {
      files: FILES,
      inputs: {
        exhibits: { concept: "demo.Exhibit", content: [new Uint8Array([1]), new Uint8Array([2])] },
      },
    });

    expect(prepared.inputs).toEqual({
      exhibits: {
        concept: "demo.Exhibit",
        content: [
          { url: "pipelex-storage://user/assets/1.bin" },
          { url: "pipelex-storage://user/assets/2.bin" },
        ],
      },
    });
    expect(prepared.uploads).toHaveLength(2);
  });

  it("uploads only the nested Image field of an envelope structured content, leaving siblings untouched", async () => {
    const client = makeClient({
      dossier: entry("demo.Dossier", {
        title: "title_value",
        cover: { url: "https://mock/c.png", mime_type: "image/png" },
      }),
    });

    const prepared = await prepareInputs(client, {
      files: FILES,
      inputs: {
        dossier: {
          concept: "demo.Dossier",
          content: { title: "Q3 report", cover: new Uint8Array([7, 7]) },
        },
      },
    });

    expect(prepared.inputs).toEqual({
      dossier: {
        concept: "demo.Dossier",
        content: { title: "Q3 report", cover: { url: "pipelex-storage://user/assets/1.bin" } },
      },
    });
    expect(prepared.uploads).toHaveLength(1);
  });

  it("handles a mix of compact and envelope inputs in one call", async () => {
    const client = makeClient({
      photo: entry("demo.Photo", { url: "https://mock/p.png" }),
      question: entry("demo.Question", { text: "text_value" }),
    });

    const prepared = await prepareInputs(client, {
      files: FILES,
      inputs: {
        photo: { concept: "demo.Photo", content: new Uint8Array([1, 2, 3]) },
        question: "What is in the photo?",
      },
    });

    expect(prepared.inputs).toEqual({
      photo: { concept: "demo.Photo", content: { url: "pipelex-storage://user/assets/1.bin" } },
      question: "What is in the photo?",
    });
    expect(prepared.uploads).toHaveLength(1);
  });

  it("is copy-on-write: neither the caller's envelope nor its inner content is mutated", async () => {
    const client = makeClient({ photo: entry("demo.Photo", { url: "https://mock/p.png" }) });
    const bytes = new Uint8Array([1, 2, 3]);
    const original = { photo: { concept: "demo.Photo", content: bytes } };

    await prepareInputs(client, { files: FILES, inputs: original });

    expect(original.photo.content).toBe(bytes);
    expect(original.photo).toEqual({ concept: "demo.Photo", content: bytes });
  });

  it("produces the same rewritten content as the compact call, plus the concept wrapper", async () => {
    const template = { photo: entry("demo.Photo", { url: "https://mock/p.png" }) };

    const compact = await prepareInputs(makeClient(template), {
      files: FILES,
      inputs: { photo: "https://example.com/real.png" },
    });
    const envelope = await prepareInputs(makeClient(template), {
      files: FILES,
      inputs: {
        photo: { concept: "demo.Photo", content: { url: "https://example.com/real.png" } },
      },
    });

    expect((envelope.inputs.photo as { content: unknown }).content).toEqual(compact.inputs.photo);
    expect(envelope.uploads).toEqual(compact.uploads);
  });
});

describe("prepareInputs by method_id", () => {
  it("resolves a stored method's closure and produces the same result as the inline-files call", async () => {
    const template = { photo: entry("demo.Photo", { url: "https://mock/p.png" }) };
    const inputs = { photo: "https://example.com/real.png" };

    // The by-id closure resolves to the same FILES the inline call passes.
    const byFiles = await prepareInputs(makeClient(template), { files: FILES, inputs });

    const client = makeClient(template, { closure: FILES });
    const byId = await prepareInputs(client, { method_id: "mt_1", inputs });

    expect(byId).toEqual(byFiles);
    expect(client.getMethodClosureCalls).toEqual(["mt_1"]);
    expect(client.uploadCalls).toHaveLength(0);
  });

  it("surfaces EmptyMethodSourceError from a source-less stored method", async () => {
    const client = makeClient(
      { photo: entry("demo.Photo", { url: "https://mock/p.png" }) },
      { closureError: new EmptyMethodSourceError("mt_empty") },
    );

    await expect(
      prepareInputs(client, { method_id: "mt_empty", inputs: { photo: new Uint8Array([1]) } }),
    ).rejects.toBeInstanceOf(EmptyMethodSourceError);
  });

  it("guards the degenerate neither-files-nor-method_id call with InputPreparationError", async () => {
    const client = makeClient({ photo: entry("demo.Photo", { url: "https://mock/p.png" }) });

    // A non-typed caller can still construct a request with neither closure source; the
    // runtime guard backs up the discriminated-union type invariant.
    await expect(
      prepareInputs(client, { inputs: { photo: "x" } } as unknown as PrepareInputsRequest),
    ).rejects.toBeInstanceOf(InputPreparationError);
  });

  it("rejects an over-specified both-files-and-method_id call before resolving the closure", async () => {
    const client = makeClient({ photo: entry("demo.Photo", { url: "https://mock/p.png" }) });

    // A non-typed caller can still supply both closure sources; the request is genuinely
    // ambiguous, so it must fail fast rather than silently preferring `method_id` — and it
    // must NOT resolve the catalog method (no throwaway fetch on the rejected path).
    await expect(
      prepareInputs(client, {
        files: FILES,
        method_id: "mt_1",
        inputs: { photo: "x" },
      } as unknown as PrepareInputsRequest),
    ).rejects.toBeInstanceOf(InputPreparationError);
    expect(client.getMethodClosureCalls).toEqual([]);
  });

  it("makes an over- or under-specified closure a type error (discriminated union)", () => {
    // @ts-expect-error — `files` and `method_id` are mutually exclusive.
    const both: PrepareInputsRequest = { files: FILES, method_id: "mt_1", inputs: {} };
    // @ts-expect-error — exactly one of `files` | `method_id` is required.
    const neither: PrepareInputsRequest = { inputs: {} };

    expect(both).toBeDefined();
    expect(neither).toBeDefined();
  });
});
