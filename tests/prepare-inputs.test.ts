/**
 * `prepareInputs` — signature-driven input preparation. Cases derive from the
 * behavior both SDKs share (`docs/input-preparation.md`), expressed on the
 * artifact that classifies: the **input-form descriptor** `POST /v1/pipe-io`
 * answers with. A `document` / `image` node marks a file position at any depth,
 * assets are uploaded and rewritten to `pipelex-storage://` in `url`,
 * http(s)/storage references pass through, dedup keys on source identity, and
 * the call is copy-on-write.
 *
 * The fake client records each `pipeIo` request and answers the way the route
 * selects — the requested ref, else the method's entry pipe, else a typed
 * selection `422` — with the selected pipe's descriptor, plus a counting
 * `upload`, so no server or filesystem is involved (except the one path case,
 * which uses a real temp file).
 */

import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  InputForm,
  InputFormField,
  InputFormItem,
  InputFormTopLevelField,
} from "mthds/protocol";
import { prepareInputs } from "../src/prepare-inputs.js";
import type { PrepareCapableClient, PrepareInputsRequest } from "../src/prepare-inputs.js";
import { InputPreparationError, RejectedAssetError, ApiResponseError } from "../src/errors.js";
import type { PipeIORequest, PipeIOResponse, PipeIOValidReport } from "../src/models.js";

// ── Descriptor fixtures ──────────────────────────────────────────────
// One constructor per kind, so a fixture reads as the signature it stands for.

const document = (required = true, extra: Record<string, unknown> = {}): InputFormItem =>
  ({ kind: "document", required, ...extra }) as InputFormItem;
const image = (required = true): InputFormItem => ({ kind: "image", required });
const text = (required = true): InputFormItem => ({ kind: "text", required });
const prose = (required = true): InputFormItem => ({ kind: "prose", required });
const unknownKind = (required = true): InputFormItem => ({ kind: "unknown", required });
const object = (fields: InputFormField[], required = true): InputFormItem => ({
  kind: "object",
  required,
  fields,
});
const list = (item: InputFormItem, required = true): InputFormItem => ({
  kind: "list",
  required,
  item,
});

/** A nested field: a node plus the authored name its parent addresses it by. */
function named(name: string, node: InputFormItem): InputFormField {
  return { ...node, name } as InputFormField;
}

/** A top-level field: a named node plus the two pipe-slot facts only this layer carries. */
function topLevel(name: string, node: InputFormItem): InputFormTopLevelField {
  return (
    node.required
      ? { ...node, name, presence: "plain", gating: true }
      : { ...node, name, presence: "optional", gating: false }
  ) as InputFormTopLevelField;
}

/** The descriptor of one pipe, keyed by its qualified ref. */
function form(pipeRef: string, fields: InputFormTopLevelField[]): InputForm {
  return { [pipeRef]: { fields } };
}

// ── The fake client ──────────────────────────────────────────────────

/** A problem-shaped `ApiResponseError`, as the client raises for a route's non-2xx. */
function apiError(status: number, errorType: string | undefined, detail: string): ApiResponseError {
  return new ApiResponseError(
    `API POST /v1/pipe-io failed (${status}): ${detail}`,
    "http://localhost:8081/v1/pipe-io",
    status,
    "Error",
    JSON.stringify({ status, detail, error_type: errorType }),
    errorType,
    detail,
    undefined,
    undefined,
  );
}

interface FakeClient extends PrepareCapableClient {
  uploadCalls: { filename: string; data: string; content_type: string }[];
  pipeIoCalls: PipeIORequest[];
}

/** Every field a `PipeIOValidReport` declares beyond the ones a case sets. */
function validReport(overrides: Partial<PipeIOValidReport> = {}): PipeIOValidReport {
  return {
    is_valid: true,
    pipe_ref: "demo.main",
    pipe_io_contracts: {},
    input_form: {},
    output_form: {},
    default_pipe_ref: "demo.main",
    pending_signatures: [],
    is_runnable: true,
    ...overrides,
  };
}

/**
 * A client whose `pipeIo` records its request and selects the way the route does:
 * the requested ref when it names a described pipe, else the method's entry pipe
 * (`defaultPipeRef`, which defaults to the only pipe of a one-pipe method), and a
 * `422` typed `EntryPipeNotFoundError` when neither selects anything. It answers
 * with the selected pipe's descriptor alone, keyed by the ref it resolved. Its
 * `upload` counts calls and hands back a deterministic URI.
 */
function makeClient(
  fields: InputFormTopLevelField[] | InputForm,
  overrides: {
    result?: PipeIOResponse;
    error?: unknown;
    defaultPipeRef?: string | null;
    uploadError?: unknown;
  } = {},
): FakeClient {
  const uploadCalls: { filename: string; data: string; content_type: string }[] = [];
  const pipeIoCalls: PipeIORequest[] = [];
  const inputForm = Array.isArray(fields) ? form("demo.main", fields) : fields;
  const refs = Object.keys(inputForm);
  const defaultPipeRef =
    overrides.defaultPipeRef !== undefined
      ? overrides.defaultPipeRef
      : refs.length === 1
        ? refs[0]!
        : null;
  let counter = 0;
  return {
    uploadCalls,
    pipeIoCalls,
    async pipeIo(request) {
      pipeIoCalls.push(request);
      if (overrides.error !== undefined) throw overrides.error;
      if (overrides.result !== undefined) return overrides.result;
      const selected = request.pipe_ref ?? defaultPipeRef;
      if (selected === null) {
        throw apiError(
          422,
          "EntryPipeNotFoundError",
          "No `pipe_ref` was given and the closure declares no `main_pipe` — name the pipe explicitly.",
        );
      }
      const descriptor = inputForm[selected];
      if (descriptor === undefined) {
        throw apiError(
          422,
          "EntryPipeNotFoundError",
          `Pipe '${selected}' not found in the submitted closure.`,
        );
      }
      return validReport({
        pipe_ref: selected,
        input_form: { [selected]: descriptor },
        default_pipe_ref: defaultPipeRef,
      });
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

// ── The signature call, per selector ─────────────────────────────────

describe("prepareInputs composes one pipeIo call, whatever the selector", () => {
  it("sends inline files verbatim, source labels and all, with no other key", async () => {
    const client = makeClient([topLevel("photo", image())]);
    const files = [{ content: "a" }, { content: "b", source: "pipes.mthds" }];

    await prepareInputs(client, { files, inputs: { photo: "https://example.com/p.png" } });

    // No `pipe_ref`, `all_pipes` or `include_files` key: the route selects the entry
    // pipe itself, and one pipe's descriptor is all preparation reads.
    expect(client.pipeIoCalls).toEqual([{ files }]);
  });

  it("passes a method_ref straight through, beside the qualified pipe_ref", async () => {
    const client = makeClient([topLevel("photo", image())]);

    await prepareInputs(client, {
      method_ref: "github.com/Pipelex/methods/documents@v0.1.0",
      pipe_ref: "demo.main",
      inputs: {},
    });

    expect(client.pipeIoCalls).toEqual([
      { method_ref: "github.com/Pipelex/methods/documents@v0.1.0", pipe_ref: "demo.main" },
    ]);
  });

  it("passes a method_id straight through — never expanded here", async () => {
    const client = makeClient([topLevel("photo", image())]);

    await prepareInputs(client, { method_id: "mt_abc123", inputs: {} });

    expect(client.pipeIoCalls).toEqual([{ method_id: "mt_abc123" }]);
  });

  it("sends the selector trimmed, and a blank pipe_ref as no pipe_ref at all", async () => {
    const client = makeClient([topLevel("photo", image())]);

    await prepareInputs(client, { method_id: "  mt_abc123 ", pipe_ref: "   ", inputs: {} });

    expect(client.pipeIoCalls).toEqual([{ method_id: "mt_abc123" }]);
  });
});

// ── The behavior matrix, on the descriptor ───────────────────────────

describe("prepareInputs", () => {
  const tempDirs: string[] = [];
  afterEach(async () => {
    await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
  });

  it("uploads a top-level Image scalar given as bytes and rewrites url to a storage URI", async () => {
    const client = makeClient([topLevel("photo", image())]);

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
    const client = makeClient([topLevel("photo", image())]);

    const prepared = await prepareInputs(client, {
      files: FILES,
      inputs: { photo: "https://example.com/real.png" },
    });

    expect(prepared.inputs).toEqual({ photo: { url: "https://example.com/real.png" } });
    expect(prepared.uploads).toHaveLength(0);
    expect(client.uploadCalls).toHaveLength(0);
  });

  it("passes an existing pipelex-storage:// URI through unchanged", async () => {
    const client = makeClient([topLevel("photo", image())]);

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
    const client = makeClient([topLevel("photo", image())]);

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
    const client = makeClient([topLevel("exhibits", list(document()))]);

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
    const client = makeClient([topLevel("question", text())]);

    const prepared = await prepareInputs(client, {
      files: FILES,
      inputs: { question: "notes/summary.txt" },
    });

    expect(prepared.inputs).toEqual({ question: "notes/summary.txt" });
    expect(client.uploadCalls).toHaveLength(0);
  });

  it("uploads only the nested Image field of a structured input, leaving siblings untouched", async () => {
    const client = makeClient([
      topLevel("dossier", object([named("title", text()), named("cover", image())])),
    ]);

    const prepared = await prepareInputs(client, {
      files: FILES,
      inputs: { dossier: { title: "Q3 report", cover: new Uint8Array([7, 7]) } },
    });

    expect(prepared.inputs).toEqual({
      dossier: { title: "Q3 report", cover: { url: "pipelex-storage://user/assets/1.bin" } },
    });
    expect(prepared.uploads).toHaveLength(1);
  });

  it("copies through the keys of a structured input the descriptor does not name", async () => {
    const client = makeClient([topLevel("dossier", object([named("cover", image())]))]);

    const prepared = await prepareInputs(client, {
      files: FILES,
      inputs: { dossier: { cover: "https://example.com/c.png", note: "kept" } },
    });

    expect(prepared.inputs).toEqual({
      dossier: { cover: { url: "https://example.com/c.png" }, note: "kept" },
    });
  });

  it("does not mistake an inherited prototype member for a caller-supplied field", async () => {
    const client = makeClient([
      topLevel("dossier", object([named("title", text()), named("constructor", image())])),
    ]);

    const prepared = await prepareInputs(client, {
      files: FILES,
      inputs: { dossier: { title: "Q3 report" } },
    });

    expect(prepared.inputs).toEqual({ dossier: { title: "Q3 report" } });
    expect(client.uploadCalls).toHaveLength(0);
  });

  it("dedups by source identity: the same bytes object uploads once", async () => {
    const client = makeClient([topLevel("exhibits", list(document()))]);
    const shared = new Uint8Array([9, 9, 9]);

    const prepared = await prepareInputs(client, {
      files: FILES,
      inputs: { exhibits: [shared, shared] },
    });

    expect(client.uploadCalls).toHaveLength(1);
    const [first, second] = prepared.inputs.exhibits as { url: string }[];
    expect(first!.url).toBe(second!.url);
  });

  it("is copy-on-write: the caller's inputs object is not mutated", async () => {
    const client = makeClient([topLevel("photo", image())]);
    const original = { photo: new Uint8Array([1, 2, 3]) };

    await prepareInputs(client, { files: FILES, inputs: original });

    expect(original.photo).toBeInstanceOf(Uint8Array);
  });

  it("passes through an input the descriptor does not declare", async () => {
    const client = makeClient([topLevel("photo", image())]);

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
    const client = makeClient([topLevel("photo", image())]);

    const prepared = await prepareInputs(client, { files: FILES, inputs: { photo: path } });

    expect(prepared.inputs).toEqual({ photo: { url: "pipelex-storage://user/assets/1.bin" } });
    expect(client.uploadCalls[0]?.content_type).toBe("image/png");
  });

  it("throws InputPreparationError for an unrecognized value at a file position", async () => {
    const client = makeClient([topLevel("photo", image())]);

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
    const client = makeClient([topLevel("photo", image())]);

    // Malformed percent-encoding — `decodeURIComponent` would otherwise throw a raw URIError
    // that escapes the typed preparation-error contract.
    await expect(
      prepareInputs(client, { files: FILES, inputs: { photo: "data:text/plain,%ZZ" } }),
    ).rejects.toBeInstanceOf(InputPreparationError);
    expect(client.uploadCalls).toHaveLength(0);
  });

  it("throws InputPreparationError for a malformed base64 data URL instead of silently uploading truncated bytes", async () => {
    const client = makeClient([topLevel("photo", image())]);

    // Node's `Buffer.from(x, "base64")` is lenient: it silently drops invalid characters and
    // returns truncated/empty bytes, so a malformed base64 payload would upload corrupt content
    // instead of failing the preparation contract. Both runtimes must reject it via `atob`.
    await expect(
      prepareInputs(client, { files: FILES, inputs: { photo: "data:image/png;base64,%%%%" } }),
    ).rejects.toBeInstanceOf(InputPreparationError);
    expect(client.uploadCalls).toHaveLength(0);
  });

  it("surfaces a rejected-asset error before returning (413 during upload)", async () => {
    const client = makeClient([topLevel("photo", image())], {
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
    });

    await expect(
      prepareInputs(client, { files: FILES, inputs: { photo: new Uint8Array([1]) } }),
    ).rejects.toBeInstanceOf(RejectedAssetError);
  });
});

// ── The two misclassifications the descriptor fixes (L-260826-ddd843) ──

describe("prepareInputs classifies from the descriptor, not the value's shape", () => {
  it("uploads an OPTIONAL nested file field when the caller supplies one", async () => {
    // The required-only inputs template never rendered an optional nested field, so
    // its file position was invisible and the caller's local path travelled to the
    // runner as a literal string. The descriptor states `required: false` and the
    // walk enters it all the same.
    const client = makeClient([
      topLevel("dossier", object([named("body", prose()), named("attachment", document(false))])),
    ]);

    const prepared = await prepareInputs(client, {
      files: FILES,
      inputs: { dossier: { body: "the note", attachment: new Uint8Array([4]) } },
    });

    expect(prepared.inputs).toEqual({
      dossier: { body: "the note", attachment: { url: "pipelex-storage://user/assets/1.bin" } },
    });
    expect(prepared.uploads).toHaveLength(1);
  });

  it("leaves a text field merely NAMED url untouched, path-like value and all", async () => {
    // The template marked a file position by rendering `{url: …}`, which a field
    // named `url` produced whatever its concept — so a text value that looked like a
    // path was read off the caller's disk and uploaded. `kind: "text"` ends that.
    const client = makeClient([
      topLevel("link", object([named("url", text()), named("label", text())])),
    ]);

    const prepared = await prepareInputs(client, {
      files: FILES,
      inputs: { link: { url: "notes/summary.txt", label: "Summary" } },
    });

    expect(prepared.inputs).toEqual({ link: { url: "notes/summary.txt", label: "Summary" } });
    expect(client.uploadCalls).toHaveLength(0);
  });

  it("treats a refining concept as the file it refines, stated by the descriptor", async () => {
    const client = makeClient([
      topLevel(
        "exhibit",
        document(true, { concept_ref: "legal.Exhibit", refines: ["native.Document"] }),
      ),
    ]);

    const prepared = await prepareInputs(client, {
      files: FILES,
      inputs: { exhibit: new Uint8Array([1, 2]) },
    });

    expect(prepared.inputs).toEqual({ exhibit: { url: "pipelex-storage://user/assets/1.bin" } });
  });

  it("uploads an image nested inside a list of structured elements, per element", async () => {
    const client = makeClient([
      topLevel("slides", list(object([named("shot", image()), named("caption", text())]))),
    ]);

    const prepared = await prepareInputs(client, {
      files: FILES,
      inputs: {
        slides: [
          { shot: new Uint8Array([1]), caption: "one" },
          { shot: new Uint8Array([2]), caption: "two" },
        ],
      },
    });

    expect(prepared.inputs).toEqual({
      slides: [
        { shot: { url: "pipelex-storage://user/assets/1.bin" }, caption: "one" },
        { shot: { url: "pipelex-storage://user/assets/2.bin" }, caption: "two" },
      ],
    });
    expect(prepared.uploads).toHaveLength(2);
  });

  it("does not path-interpret a bare string at an unknown (Dynamic) input", async () => {
    const client = makeClient([topLevel("freeform", unknownKind())]);

    const prepared = await prepareInputs(client, {
      files: FILES,
      inputs: { freeform: "just some text that resembles/a/path" },
    });

    expect(prepared.inputs).toEqual({ freeform: "just some text that resembles/a/path" });
    expect(client.uploadCalls).toHaveLength(0);
  });

  it("leaves a canonical file dict nested inside an unknown input alone — no upload", async () => {
    // DELIBERATE CHANGE from the template walk, which uploaded this by value shape.
    // `unknown` is the standard's escape hatch for a Dynamic / Composite input: the
    // signature declares no file there, and uploading on the strength of a `url` key
    // is exactly the guess this helper stopped making. Such a caller uploads with
    // `uploadFile` first and passes the storage URI — what `docs/input-preparation.md`
    // has always said.
    const client = makeClient([topLevel("data", unknownKind())]);
    const value = { text: "hi", images: [{ url: "/local/photo.png" }] };

    const prepared = await prepareInputs(client, { files: FILES, inputs: { data: value } });

    expect(prepared.inputs).toEqual({ data: value });
    expect(client.uploadCalls).toHaveLength(0);
  });
});

// ── The explicit envelope ────────────────────────────────────────────

describe("prepareInputs with the explicit { concept, content } envelope", () => {
  // The caller may hand back a `{ concept, content }` envelope per input.
  // Preparation unwraps `.content`, walks it against the same descriptor node,
  // then re-wraps — preserving the concept annotation for the run.

  it("uploads an envelope Image whose content is bytes and re-wraps the rewritten content", async () => {
    const client = makeClient([topLevel("photo", image())]);

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
    const client = makeClient([topLevel("photo", image())]);

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
    const client = makeClient([topLevel("photo", image())]);

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
    const client = makeClient([topLevel("photo", image())]);

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
    const client = makeClient([topLevel("question", text())]);

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
    const client = makeClient([topLevel("exhibits", list(document()))]);

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
    const client = makeClient([
      topLevel("dossier", object([named("title", text()), named("cover", image())])),
    ]);

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
    const client = makeClient([topLevel("photo", image()), topLevel("question", text())]);

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
    const client = makeClient([topLevel("photo", image())]);
    const bytes = new Uint8Array([1, 2, 3]);
    const original = { photo: { concept: "demo.Photo", content: bytes } };

    await prepareInputs(client, { files: FILES, inputs: original });

    expect(original.photo.content).toBe(bytes);
    expect(original.photo).toEqual({ concept: "demo.Photo", content: bytes });
  });

  it("produces the same rewritten content as the compact call, plus the concept wrapper", async () => {
    const fields = [topLevel("photo", image())];

    const compact = await prepareInputs(makeClient(fields), {
      files: FILES,
      inputs: { photo: "https://example.com/real.png" },
    });
    const envelope = await prepareInputs(makeClient(fields), {
      files: FILES,
      inputs: {
        photo: { concept: "demo.Photo", content: { url: "https://example.com/real.png" } },
      },
    });

    expect((envelope.inputs.photo as { content: unknown }).content).toEqual(compact.inputs.photo);
    expect(envelope.uploads).toEqual(compact.uploads);
  });
});

// ── Pipe selection ───────────────────────────────────────────────────

describe("prepareInputs pipe selection", () => {
  /** Two pipes, each declaring one image input under a name only it carries. */
  const TWO_PIPES: InputForm = {
    ...form("demo.first", [topLevel("first_only", image())]),
    ...form("demo.second", [topLevel("second_only", image())]),
  };

  it("sends an explicit qualified pipe_ref and walks the pipe the route selected", async () => {
    const client = makeClient(TWO_PIPES);

    const prepared = await prepareInputs(client, {
      files: FILES,
      pipe_ref: "demo.second",
      inputs: { first_only: new Uint8Array([1]), second_only: new Uint8Array([2]) },
    });

    expect(client.pipeIoCalls[0]!.pipe_ref).toBe("demo.second");
    // Only `second_only` is declared by `demo.second`; `first_only` passes through.
    expect(prepared.uploads).toHaveLength(1);
    expect(prepared.inputs.first_only).toBeInstanceOf(Uint8Array);
  });

  it("walks the method's entry pipe the route resolved when no pipe_ref is given", async () => {
    // The route's chain — a fetched manifest's `main_pipe`, else the closure's single
    // declaration — is the answer. Preparation derives no default of its own.
    const client = makeClient(TWO_PIPES, { defaultPipeRef: "demo.second" });

    const prepared = await prepareInputs(client, {
      method_ref: "github.com/Pipelex/methods/documents",
      inputs: { first_only: new Uint8Array([1]), second_only: new Uint8Array([2]) },
    });

    expect(client.pipeIoCalls[0]).not.toHaveProperty("pipe_ref");
    expect(prepared.uploads).toHaveLength(1);
    expect(prepared.inputs.first_only).toBeInstanceOf(Uint8Array);
  });

  it("walks the ref the route answered with, not the one the request spelled", async () => {
    // A qualified request resolves to itself; the answer's `pipe_ref` is still what
    // keys the descriptor, so preparation reads it rather than the request's spelling.
    const client = makeClient([], {
      result: validReport({
        pipe_ref: "demo.second",
        input_form: form("demo.second", [topLevel("second_only", image())]),
      }),
    });

    const prepared = await prepareInputs(client, {
      files: FILES,
      pipe_ref: "demo.second",
      inputs: { second_only: new Uint8Array([2]) },
    });

    expect(prepared.uploads).toHaveLength(1);
  });

  it("refuses a bare pipe_code before any request", async () => {
    const client = makeClient(TWO_PIPES);

    const failure = prepareInputs(client, { files: FILES, pipe_ref: "second", inputs: {} });

    await expect(failure).rejects.toBeInstanceOf(InputPreparationError);
    await expect(failure).rejects.toThrow(/qualified/);
    await expect(failure).rejects.toThrow(/"second"/);
    expect(client.pipeIoCalls).toHaveLength(0);
  });

  // Pins the decision, not a regression: an `alias->domain.pipe_code` ref names a
  // DEPENDENCY package's pipe, and preparation covers the method's own pipes — the
  // crate routes do not load an address-based dependency at all. The run route takes
  // such a ref; preparation refuses it, and that asymmetry is deliberate.
  it("refuses an alias-qualified pipe_ref before any request", async () => {
    const client = makeClient(TWO_PIPES);

    const failure = prepareInputs(client, {
      files: FILES,
      pipe_ref: "vendor->demo.second",
      inputs: {},
    });

    await expect(failure).rejects.toBeInstanceOf(InputPreparationError);
    await expect(failure).rejects.toThrow(/dependency package/);
    expect(client.pipeIoCalls).toHaveLength(0);
  });

  it("turns the route's refusal of an unknown pipe_ref into an InputPreparationError", async () => {
    const client = makeClient(TWO_PIPES);

    const failure = prepareInputs(client, {
      files: FILES,
      pipe_ref: "demo.absent",
      inputs: { first_only: new Uint8Array([1]) },
    });

    await expect(failure).rejects.toBeInstanceOf(InputPreparationError);
    await expect(failure).rejects.toThrow(/Pipe 'demo\.absent' not found/);
    const error = await failure.catch((caught: unknown) => caught);
    expect((error as InputPreparationError).cause).toBeInstanceOf(ApiResponseError);
    expect(client.uploadCalls).toHaveLength(0);
  });

  it("turns the route's refusal for want of an entry pipe into an InputPreparationError", async () => {
    // One pipe and no `main_pipe`: the run route has no single-pipe fallback, so a
    // selector-less run is refused, and the route refuses the selection the same way.
    const client = makeClient([topLevel("photo", image())], { defaultPipeRef: null });

    const failure = prepareInputs(client, { files: FILES, inputs: { photo: new Uint8Array([1]) } });

    await expect(failure).rejects.toBeInstanceOf(InputPreparationError);
    await expect(failure).rejects.toThrow(/declares no `main_pipe`/);
    expect(client.uploadCalls).toHaveLength(0);
  });

  it("turns an ambiguous selection into an InputPreparationError carrying the server's candidates", async () => {
    const detail =
      "No `pipe_ref` was given and the closure declares several `main_pipe`s " +
      "(demo.first, demo.second) — name the pipe explicitly.";
    const client = makeClient(TWO_PIPES, {
      error: apiError(422, "EntryPipeAmbiguousError", detail),
    });

    const failure = prepareInputs(client, { files: FILES, inputs: {} });

    await expect(failure).rejects.toBeInstanceOf(InputPreparationError);
    await expect(failure).rejects.toThrow(/demo\.first, demo\.second/);
  });

  it("refuses an answer whose input_form does not describe the pipe it selected", async () => {
    // One answer, one pipe: a selected ref the descriptor does not key is the answer
    // contradicting itself, and walking any other pipe would prepare the wrong signature.
    const client = makeClient([], {
      result: validReport({
        pipe_ref: "demo.gone",
        input_form: form("demo.first", [topLevel("first_only", image())]),
      }),
    });

    const failure = prepareInputs(client, { files: FILES, inputs: {} });

    await expect(failure).rejects.toBeInstanceOf(InputPreparationError);
    await expect(failure).rejects.toThrow(/demo\.gone/);
    await expect(failure).rejects.toThrow(/demo\.first/);
  });

  it("refuses an answer that selected no pipe", async () => {
    // Only `all_pipes` answers a null `pipe_ref`, and preparation never asks for it —
    // so a null here is a server out of contract, not a default to invent.
    const client = makeClient([], {
      result: validReport({
        pipe_ref: null,
        input_form: form("demo.first", [topLevel("first_only", image())]),
      }),
    });

    const failure = prepareInputs(client, { files: FILES, inputs: {} });

    await expect(failure).rejects.toBeInstanceOf(InputPreparationError);
    await expect(failure).rejects.toThrow(/no pipe/);
  });
});

// ── Verdicts, selectors, and errors ──────────────────────────────────

describe("prepareInputs verdicts and guards", () => {
  it("throws InputPreparationError when the closure does not resolve", async () => {
    const client = makeClient([], {
      result: {
        is_valid: false,
        message: "MTHDS library could not be resolved",
        validation_errors: [{ category: "blueprint_validation", message: "unknown pipe type" }],
      },
    });

    const failure = prepareInputs(client, {
      files: FILES,
      inputs: { photo: new Uint8Array([1]) },
    });
    await expect(failure).rejects.toBeInstanceOf(InputPreparationError);
    await expect(failure).rejects.toThrow(/unknown pipe type/);
  });

  it("prepares a pipe whose method still has a pending signature elsewhere", async () => {
    // Preparation needs the pipe's DECLARED inputs; whether the method runs is the
    // run's verdict. The route reports runnability beside the form and refuses nothing.
    const client = makeClient([], {
      result: validReport({
        input_form: form("demo.main", [topLevel("photo", image())]),
        pending_signatures: ["demo.later"],
        is_runnable: false,
      }),
    });

    const prepared = await prepareInputs(client, {
      files: FILES,
      inputs: { photo: new Uint8Array([1]) },
    });

    expect(prepared.uploads).toHaveLength(1);
  });

  it("propagates a request-shape 422 unchanged — only a selection refusal is reclassified", async () => {
    // A package with no `.mthds` file, an over-limit file, a stored method with no
    // source: every such 422 carries the generic `ValidationError` type and stays an
    // `ApiResponseError`, since nothing about the pipe selection failed.
    const shapeError = apiError(
      422,
      "ValidationError",
      "Method package 'github.com/o/r' contains no .mthds file.",
    );
    const client = makeClient([topLevel("photo", image())], { error: shapeError });

    await expect(prepareInputs(client, { method_ref: "github.com/o/r", inputs: {} })).rejects.toBe(
      shapeError,
    );
  });

  it("propagates a selection-typed error on another status unchanged", async () => {
    const odd = apiError(500, "EntryPipeNotFoundError", "unexpected");
    const client = makeClient([topLevel("photo", image())], { error: odd });

    await expect(prepareInputs(client, { files: FILES, inputs: {} })).rejects.toBe(odd);
  });

  it("propagates a no-verdict ApiResponseError from the route unchanged", async () => {
    const notFound = apiError(404, undefined, "no such method");
    const client = makeClient([topLevel("photo", image())], { error: notFound });

    await expect(prepareInputs(client, { method_id: "mt_missing", inputs: {} })).rejects.toBe(
      notFound,
    );
    expect(client.uploadCalls).toHaveLength(0);
  });

  it("rejects a call with no method selector", async () => {
    const client = makeClient([topLevel("photo", image())]);

    const failure = prepareInputs(client, {
      inputs: { photo: "x" },
    } as unknown as PrepareInputsRequest);
    await expect(failure).rejects.toBeInstanceOf(InputPreparationError);
    await expect(failure).rejects.toThrow(/method_ref/);
    expect(client.pipeIoCalls).toHaveLength(0);
  });

  it("rejects a call carrying two selectors", async () => {
    const client = makeClient([topLevel("photo", image())]);

    const failure = prepareInputs(client, {
      files: FILES,
      method_id: "mt_1",
      inputs: {},
    } as unknown as PrepareInputsRequest);
    await expect(failure).rejects.toBeInstanceOf(InputPreparationError);
    await expect(failure).rejects.toThrow(/were both given/);
    expect(client.pipeIoCalls).toHaveLength(0);
  });

  it("rejects a call carrying all three selectors", async () => {
    const client = makeClient([topLevel("photo", image())]);

    const failure = prepareInputs(client, {
      files: FILES,
      method_ref: "github.com/Pipelex/methods/documents",
      method_id: "mt_1",
      inputs: {},
    } as unknown as PrepareInputsRequest);
    await expect(failure).rejects.toBeInstanceOf(InputPreparationError);
    await expect(failure).rejects.toThrow(/were all given/);
  });

  it("treats empty selectors as absent — an empty files array is no selector", async () => {
    const client = makeClient([topLevel("photo", image())]);

    await expect(
      prepareInputs(client, { files: [], inputs: {} } as unknown as PrepareInputsRequest),
    ).rejects.toThrow(/no method selector/);
  });

  it("treats a blank method_ref and a blank method_id as absent", async () => {
    const client = makeClient([topLevel("photo", image())]);

    await expect(
      prepareInputs(client, { method_ref: "   ", inputs: {} } as unknown as PrepareInputsRequest),
    ).rejects.toThrow(/no method selector/);
    await expect(
      prepareInputs(client, { method_id: "", inputs: {} } as unknown as PrepareInputsRequest),
    ).rejects.toThrow(/no method selector/);
  });

  it("lets an empty selector sit beside a real one without tripping the XOR", async () => {
    const client = makeClient([topLevel("photo", image())]);

    await prepareInputs(client, {
      files: FILES,
      method_id: "",
      inputs: {},
    } as unknown as PrepareInputsRequest);

    expect(client.pipeIoCalls[0]).toEqual({ files: FILES });
  });
});

describe("PrepareInputsRequest is a type-level XOR over the three selectors", () => {
  it("accepts each selector alone and rejects every pair", () => {
    const byFiles: PrepareInputsRequest = { files: FILES, inputs: {} };
    const byRef: PrepareInputsRequest = { method_ref: "github.com/o/r", inputs: {} };
    const byId: PrepareInputsRequest = { method_id: "mt_1", inputs: {} };

    // @ts-expect-error — `files` and `method_ref` are mutually exclusive.
    const filesAndRef: PrepareInputsRequest = {
      files: FILES,
      method_ref: "github.com/o/r",
      inputs: {},
    };
    // @ts-expect-error — `files` and `method_id` are mutually exclusive.
    const filesAndId: PrepareInputsRequest = { files: FILES, method_id: "mt_1", inputs: {} };
    // @ts-expect-error — `method_ref` and `method_id` are mutually exclusive.
    const refAndId: PrepareInputsRequest = {
      method_ref: "github.com/o/r",
      method_id: "mt_1",
      inputs: {},
    };
    // @ts-expect-error — a request must name the method some way.
    const noSelector: PrepareInputsRequest = { inputs: {} };

    expect([byFiles, byRef, byId, filesAndRef, filesAndId, refAndId, noSelector]).toHaveLength(7);
  });
});
