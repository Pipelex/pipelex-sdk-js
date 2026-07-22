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
import type { PrepareCapableClient } from "../src/prepare-inputs.js";
import { InputPreparationError, RejectedAssetError, ApiResponseError } from "../src/errors.js";
import type { BuildInputsResponse } from "../src/models.js";

/** Build an explicit-template envelope entry. */
function entry(concept: string, content: unknown): { concept: string; content: unknown } {
  return { concept, content };
}

interface FakeClient extends PrepareCapableClient {
  uploadCalls: { filename: string; data: string; content_type: string }[];
}

/** Fake client: `buildInputs` returns the given envelope template; `upload` counts calls. */
function makeClient(
  template: Record<string, unknown>,
  overrides: { report?: BuildInputsResponse; uploadError?: unknown } = {},
): FakeClient {
  const uploadCalls: { filename: string; data: string; content_type: string }[] = [];
  let counter = 0;
  return {
    uploadCalls,
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
    async upload(input) {
      if (overrides.uploadError) throw overrides.uploadError;
      counter += 1;
      uploadCalls.push(input);
      return { uri: `pipelex-storage://user/assets/${counter}.bin`, filename: input.filename };
    },
  };
}

const FILES = [{ content: 'domain = "demo"' }];

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
