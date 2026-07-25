/**
 * `prepareInputs` — signature-driven input preparation. Resolves the target
 * pipe's declared inputs via the explicit inputs template, interprets the
 * caller's inputs top-down against it, uploads the file-bearing values, and
 * returns rewritten inputs (canonical content carrying `pipelex-storage://` in
 * `url`) plus one upload record per prepared asset.
 *
 * Per input, the caller may submit EITHER the **compact** value (a bare source /
 * canonical `{url}` content) OR the explicit `{ concept, content }` envelope that
 * `buildInputs({ explicit: true })` hands back — its `content` is interpreted
 * exactly as the compact value would be, and the envelope is preserved on output
 * (the `concept` annotation rides through; the runtime accepts it — see
 * `pipelex`'s `input_shaper.py` `_is_explicit` / `input_normalizer.py`).
 *
 * The classification mirrors the runtime: `pipelex`'s `input_normalizer` walks
 * Image/Document contents (recognized by their `url`-bearing shape, incl. nested
 * in structured content) and `resolve_uri` decides upload vs pass-through. The
 * declared signature comes from the explicit template (`buildInputs`,
 * `explicit: true`), whose canonical content shape is the classifier — the file
 * signal is a value that is a dict containing a `url` key. See the shared
 * behavior matrix (`wip/upload/behavior-matrix.md`) and `docs/input-preparation.md`.
 */

import { InputPreparationError } from "./errors.js";
import type { BuildInputsResponse, MthdsFileItem } from "./models.js";
import type { UploadCapableClient, UploadRecord } from "./upload.js";
import { uploadFile } from "./upload.js";

const PIPELEX_STORAGE_SCHEME = "pipelex-storage://";
const HTTP_URL_RE = /^https?:\/\//i;

/** The pipe selector + caller inputs shared by both closure-source shapes. */
interface PrepareInputsBase {
  /** The pipe to prepare inputs for, as a qualified `domain.pipe_code`; omit to default to the closure's `main_pipe`. */
  pipe_ref?: string;
  /** The caller's compact inputs (variable name → value). */
  inputs: Record<string, unknown>;
}

/**
 * What `prepareInputs` takes: the method closure, the target pipe, and the
 * caller's compact inputs. Supply the closure EITHER as inline `files` OR as a
 * stored `method_id` — never both. `method_id` is a client-side convenience:
 * it is resolved to `files` via `getMethodClosure` before anything hits the
 * wire (it never travels as a wire field), and requires an API key.
 */
export type PrepareInputsRequest =
  | (PrepareInputsBase & {
      /** The method closure — inline MTHDS files. This is the signature source. */
      files: MthdsFileItem[];
      method_id?: never;
    })
  | (PrepareInputsBase & {
      /** A stored method's id — resolved client-side to its closure before the build call. */
      method_id: string;
      files?: never;
    });

/** The result of `prepareInputs`: rewritten inputs (copy-on-write) plus upload records. */
export interface PreparedInputs {
  /** A copy of `inputs` with each file-bearing value rewritten to canonical content carrying `pipelex-storage://` in `url`. */
  inputs: Record<string, unknown>;
  /** One record per uploaded asset, exposing `uri`. Pass-through references (http(s), existing storage URIs) produce no record. */
  uploads: UploadRecord[];
}

/**
 * The client surface `prepareInputs` needs: raw `upload`, the `buildInputs`
 * signature source, and `getMethodClosure` to resolve a by-id request's closure.
 */
export interface PrepareCapableClient extends UploadCapableClient {
  buildInputs(request: {
    files: MthdsFileItem[];
    pipe_ref?: string;
    format?: "json";
    explicit?: boolean;
  }): Promise<BuildInputsResponse>;
  /** Resolve a stored method's id into its runnable closure — the by-id signature source. */
  getMethodClosure(methodId: string): Promise<MthdsFileItem[]>;
}

/** Mutable state threaded through one preparation walk. */
interface PrepareContext {
  client: UploadCapableClient;
  uploads: UploadRecord[];
  /** Dedup by source identity: same source (string value / bytes reference) uploads once. */
  dedup: Map<unknown, Promise<string>>;
}

/** Strict plain-object test — excludes arrays, `Uint8Array`, `Blob`, and other exotics. */
function isPlainObject(value: unknown): value is Record<string, unknown> {
  return Object.prototype.toString.call(value) === "[object Object]";
}

/** A canonical Image/Document content is a plain object carrying a `url` key. */
function isFileContent(node: unknown): node is Record<string, unknown> {
  return isPlainObject(node) && "url" in node;
}

/**
 * The explicit-template envelope: a plain object whose keys are EXACTLY `concept`
 * and `content` — the shape `buildInputs({ explicit: true })` returns per input.
 * Matches the runtime's `_is_explicit` (`pipelex`'s `input_shaper.py`): exact
 * keys, not a superset, so a structured-content input that merely happens to carry
 * both fields is not misread as an envelope.
 */
function isExplicitEnvelope(value: unknown): value is { concept: unknown; content: unknown } {
  if (!isPlainObject(value)) return false;
  const keys = Object.keys(value);
  return keys.length === 2 && "concept" in value && "content" in value;
}

/** Decode a `data:` URL into bytes plus its MIME type. */
function decodeDataUrl(dataUrl: string): { bytes: Uint8Array; contentType: string } {
  const comma = dataUrl.indexOf(",");
  if (comma < 0) {
    throw new InputPreparationError(
      `Malformed data URL (no comma separator): ${dataUrl.slice(0, 32)}…`,
    );
  }
  const header = dataUrl.slice(5, comma); // strip "data:"
  const payload = dataUrl.slice(comma + 1);
  const isBase64 = /;base64/i.test(header);
  const contentType = header.split(";")[0] || "application/octet-stream";
  // Decoding can throw on a malformed payload — a URIError from percent-decoding,
  // or an InvalidCharacterError from `atob` on bad base64. Surface those as a typed
  // InputPreparationError so a bad data URL stays within the preparation contract.
  try {
    if (isBase64) {
      // Decode via atob in every runtime. atob rejects malformed base64 with an
      // InvalidCharacterError — Buffer.from(payload, "base64") does NOT: in Node it
      // silently drops invalid characters and returns truncated/empty bytes, which would
      // upload corrupt content instead of failing the preparation contract. atob is a
      // global in every supported runtime (engines.node >= 22.12).
      return { bytes: base64ToBytes(payload), contentType };
    }
    const text = decodeURIComponent(payload);
    return { bytes: new TextEncoder().encode(text), contentType };
  } catch (cause) {
    throw new InputPreparationError(
      `Malformed data URL payload (${isBase64 ? "invalid base64" : "invalid percent-encoding"}): ${dataUrl.slice(0, 32)}…`,
      { cause },
    );
  }
}

/**
 * Strict cross-runtime base64 decode via `atob` — the single decoder for data-URL
 * payloads in every runtime. `atob` throws an `InvalidCharacterError` on malformed
 * base64, unlike the lenient `Buffer.from(payload, "base64")`, so a bad payload
 * fails the preparation contract instead of yielding truncated/empty bytes.
 */
function base64ToBytes(base64: string): Uint8Array {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

/** Resolve one source (string reference or bytes) to the URL/URI to write, deduped by identity. */
function resolveSource(ctx: PrepareContext, source: unknown): Promise<string> {
  const cached = ctx.dedup.get(source);
  if (cached !== undefined) return cached;
  const pending = doResolveSource(ctx, source);
  ctx.dedup.set(source, pending);
  return pending;
}

async function doResolveSource(ctx: PrepareContext, source: unknown): Promise<string> {
  if (typeof source === "string") {
    if (source.startsWith(PIPELEX_STORAGE_SCHEME)) return source; // already prepared
    if (HTTP_URL_RE.test(source)) return source; // reachable URL — pass through
    if (source.startsWith("data:")) {
      const { bytes, contentType } = decodeDataUrl(source);
      const record = await uploadFile(ctx.client, bytes, { contentType });
      ctx.uploads.push(record);
      return record.uri;
    }
    // Anything else is a local filesystem path — Node only (uploadFile enforces it).
    const record = await uploadFile(ctx.client, source);
    ctx.uploads.push(record);
    return record.uri;
  }
  if (source instanceof Blob || source instanceof ArrayBuffer || source instanceof Uint8Array) {
    const record = await uploadFile(ctx.client, source);
    ctx.uploads.push(record);
    return record.uri;
  }
  // An unrecognized value sits at a file-bearing position (neither a source string,
  // bytes, nor a canonical `{url}` content dict). Fail with a typed error rather than
  // letting a raw TypeError escape from the byte-extraction path.
  throw new InputPreparationError(
    `Unsupported value at a file input: expected a path string, bytes (Blob/File/ArrayBuffer/Uint8Array), ` +
      `a data URL, an http(s)/pipelex-storage:// URL, or canonical {url} content; got ${typeof source}.`,
  );
}

/** Resolve a value known to sit at a file position into canonical content with a rewritten `url`. */
async function resolveFilePosition(ctx: PrepareContext, callerValue: unknown): Promise<unknown> {
  if (isFileContent(callerValue)) {
    const resolved = await resolveSource(ctx, callerValue.url);
    return { ...callerValue, url: resolved };
  }
  const resolved = await resolveSource(ctx, callerValue);
  return { url: resolved };
}

/** Template-guided walk: a template node that is canonical file content marks a file position. */
async function resolveNode(
  ctx: PrepareContext,
  templateNode: unknown,
  callerValue: unknown,
): Promise<unknown> {
  if (isFileContent(templateNode)) {
    return resolveFilePosition(ctx, callerValue);
  }
  if (Array.isArray(templateNode) && templateNode.length > 0) {
    const elementTemplate = templateNode[0];
    if (Array.isArray(callerValue)) {
      return Promise.all(callerValue.map((item) => resolveNode(ctx, elementTemplate, item)));
    }
    return callerValue; // shape mismatch — leave it for the run to reject
  }
  if (isPlainObject(templateNode) && isPlainObject(callerValue)) {
    const result: Record<string, unknown> = { ...callerValue };
    for (const key of Object.keys(templateNode)) {
      if (key in callerValue) {
        result[key] = await resolveNode(ctx, templateNode[key], callerValue[key]);
      }
    }
    return result;
  }
  return callerValue; // scalar (text/number/…) or shape mismatch — pass through
}

/**
 * Resolve a `files` / `method_id` closure pair to inline files: reject an
 * over-specified `{ files, method_id }` (both given) before any resolution
 * runs, then either return the inline `files` unchanged or fetch-and-parse the
 * stored method behind `method_id` via `getMethodClosure`. Returns `undefined`
 * when NEITHER is given — the caller decides what that means for its own
 * request shape, since `buildInputs` (client.ts) also accepts a third source,
 * the reserved `method_ref`, that `prepareInputs` does not.
 *
 * Shared between `PipelexApiClient.buildInputs` and `resolveClosureFiles`
 * (below) so the files/method_id invariant is defined in exactly one place —
 * a duplicated copy of this exact check is what let a `buildInputs`-only
 * revision briefly reject a legitimate `method_ref`-only request.
 */
export async function resolveFilesOrMethodId(
  files: MthdsFileItem[] | undefined,
  methodId: string | undefined,
  getMethodClosure: (methodId: string) => Promise<MthdsFileItem[]>,
  makeError: (message: string) => Error,
): Promise<MthdsFileItem[] | undefined> {
  if (methodId !== undefined && files !== undefined) {
    throw makeError("supply the closure as either `files` or `method_id`, never both.");
  }
  if (methodId !== undefined) {
    return getMethodClosure(methodId);
  }
  return files;
}

/**
 * Resolve the request's closure to inline `files`: fetch and parse a stored
 * method when `method_id` is given, else use the inline `files`. The either/or
 * is a type invariant (the discriminated union); {@link resolveFilesOrMethodId}
 * backs the over-specified "both given" case at runtime for non-typed callers,
 * and the "neither given" case is rejected here (prepareInputs has no third
 * closure source, unlike `buildInputs`).
 */
async function resolveClosureFiles(
  client: PrepareCapableClient,
  request: PrepareInputsRequest,
): Promise<MthdsFileItem[]> {
  const files = await resolveFilesOrMethodId(
    request.files,
    request.method_id,
    (methodId) => client.getMethodClosure(methodId),
    (message) => new InputPreparationError(`Cannot prepare inputs: ${message}`),
  );
  if (files === undefined) {
    throw new InputPreparationError(
      "Cannot prepare inputs: supply either `files` (an inline MTHDS closure) or `method_id` (a stored method).",
    );
  }
  return files;
}

/**
 * Prepare a pipe's inputs: upload local/byte/data-URL assets at the signature's
 * file-bearing positions and return copy-on-write rewritten inputs plus upload
 * records. HTTP(S) URLs and existing `pipelex-storage://` URIs pass through
 * unchanged. All failures are raised before any run is created.
 *
 * The declared signature is resolved from the closure; a closure that does not
 * resolve throws {@link InputPreparationError}. No-verdict conditions from the
 * signature route (unknown `pipe_ref`, auth, server fault) surface as the build
 * route's `ApiResponseError`.
 */
export async function prepareInputs(
  client: PrepareCapableClient,
  request: PrepareInputsRequest,
): Promise<PreparedInputs> {
  const files = await resolveClosureFiles(client, request);

  const report = await client.buildInputs({
    files,
    ...(request.pipe_ref === undefined ? {} : { pipe_ref: request.pipe_ref }),
    format: "json",
    explicit: true,
  });

  if (!report.is_valid) {
    const first = report.validation_errors[0]?.message ?? report.message;
    throw new InputPreparationError(
      `Cannot prepare inputs: the method signature did not resolve — ${first}`,
    );
  }
  // We requested `format: "json"`, so the valid arm carries the envelope in `inputs`.
  if (report.format !== "json") {
    throw new InputPreparationError(
      `Cannot prepare inputs: expected a JSON inputs template, got "${report.format}".`,
    );
  }
  const template = report.inputs;

  const ctx: PrepareContext = { client, uploads: [], dedup: new Map() };
  const rewritten: Record<string, unknown> = { ...request.inputs };
  for (const [name, callerValue] of Object.entries(request.inputs)) {
    const entry = template[name];
    if (!isPlainObject(entry) || !("content" in entry)) {
      // Not a declared input (or an unexpected envelope) — pass through untouched.
      continue;
    }
    if (isExplicitEnvelope(callerValue)) {
      // The caller filled the explicit `{ concept, content }` template: walk the
      // inner content against the compact signature, then re-wrap so the concept
      // annotation rides through to the run (the runtime accepts the envelope).
      const walked = await resolveNode(ctx, entry.content, callerValue.content);
      rewritten[name] = { ...callerValue, content: walked };
    } else {
      rewritten[name] = await resolveNode(ctx, entry.content, callerValue);
    }
  }

  return { inputs: rewritten, uploads: ctx.uploads };
}
