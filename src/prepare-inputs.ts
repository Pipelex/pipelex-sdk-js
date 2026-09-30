/**
 * `prepareInputs` — signature-driven input preparation. Reads the target pipe's
 * declared inputs from the **input-form descriptor** `POST /v1/pipe-io` returns,
 * interprets the caller's inputs top-down against it, uploads the file-bearing
 * values, and returns rewritten inputs (canonical content carrying
 * `pipelex-storage://` in `url`) plus one upload record per prepared asset.
 *
 * The method is named the same three ways every other method-taking operation
 * takes it — inline `files`, a `method_ref` address, or a stored `method_id` —
 * exactly one per call. All three are pass-throughs to `POST /v1/pipe-io`, which
 * resolves an address on the runner and an id on the platform, so nothing is
 * expanded client-side. The route also SELECTS the pipe: the caller's qualified
 * `pipe_ref`, else the method's own entry pipe, and the ref it answers with is
 * the one prepared. It runs no dry run, so preparing inputs costs one static load.
 *
 * Per input, the caller may submit EITHER the **compact** value (a bare source /
 * canonical `{url}` content) OR the explicit `{ concept, content }` envelope —
 * its `content` is interpreted exactly as the compact value would be, and the
 * envelope is preserved on output (the `concept` annotation rides through; the
 * runtime accepts it — see `pipelex`'s `input_shaper.py` `_is_explicit` /
 * `input_normalizer.py`).
 *
 * **The descriptor is the classifier, never the value's shape.** `input_form`
 * (the MTHDS standard's artifact) states the kind at every depth — `document` /
 * `image` mark a file position, `object` recurses through `fields`, `list`
 * through `item`, everything else passes through. That is what makes an
 * OPTIONAL nested file field prepare like a required one, and a `text` field
 * merely *named* `url` stay untouched: both were misread while the signature
 * came from the rendered inputs template, whose file signal was a `url`-bearing
 * dict. See `docs/input-preparation.md`, which `pipelex-sdk-python` mirrors case
 * for case.
 */

import type {
  InputForm,
  InputFormItem,
  InputFormTopLevelField,
  PipeInputFormDescriptor,
} from "mthds/protocol";
import { ApiResponseError, InputPreparationError } from "./errors.js";
import type { MthdsFileItem, PipeIORequest, PipeIOResponse, PipeIOValidReport } from "./models.js";
import type { UploadCapableClient, UploadRecord } from "./upload.js";
import { uploadFile } from "./upload.js";

const PIPELEX_STORAGE_SCHEME = "pipelex-storage://";
const HTTP_URL_RE = /^https?:\/\//i;

/**
 * The `error_type`s of the route's pipe-selection refusals — the only `422`s
 * `prepareInputs` turns into an `InputPreparationError`. They are the runtime's
 * entry-lookup classes, the vocabulary the run routes speak too: a ref that names
 * no pipe, or no entry pipe at all, is `EntryPipeNotFoundError`; a code that
 * matches pipes in several domains, or several `main_pipe` declarations, is
 * `EntryPipeAmbiguousError`. Every other `422` (a malformed body, an over-limit
 * file, a fetched package with no `.mthds` file, a stored method with no source)
 * shares the generic `ValidationError` type and stays an `ApiResponseError`.
 */
const PIPE_SELECTION_ERROR_TYPES: ReadonlySet<string> = new Set([
  "EntryPipeNotFoundError",
  "EntryPipeAmbiguousError",
]);

/** The shared half of the request: the target pipe and the caller's inputs. */
export interface PrepareInputsBase {
  /**
   * The pipe to prepare inputs for, as a QUALIFIED `domain.pipe_code` ref. Omit
   * it and the server picks the method's own entry pipe — see "Pipe selection" in
   * `docs/input-preparation.md`. A bare `pipe_code` is refused before any request:
   * a request names a pipe by its qualified ref, and search is a run-route
   * affordance this helper deliberately does not grow. So is an
   * `alias->domain.pipe_code` ref: the alias names a dependency package's pipe,
   * and preparation covers the method's own pipes.
   */
  pipe_ref?: string;
  /** The caller's inputs (variable name → value), compact or explicit-envelope per input. */
  inputs: Record<string, unknown>;
}

/**
 * How the method is named — exactly one of the three selectors, each pinning the
 * other two to `never` so a second one is a compile error (the same XOR
 * `ValidateMethodSelector` states for `validate`). All three reach the
 * server as-is: `files` inline, `method_ref` resolved by the runner, `method_id`
 * resolved by the platform.
 */
export type PrepareInputsClosure =
  | { files: MthdsFileItem[]; method_ref?: never; method_id?: never }
  | { method_ref: string; files?: never; method_id?: never }
  | { method_id: string; files?: never; method_ref?: never };

/** What `prepareInputs` takes: one method selector, the target pipe, the caller's inputs. */
export type PrepareInputsRequest = PrepareInputsBase & PrepareInputsClosure;

/** The result of `prepareInputs`: rewritten inputs (copy-on-write) plus upload records. */
export interface PreparedInputs {
  /** A copy of `inputs` with each file-bearing value rewritten to canonical content carrying `pipelex-storage://` in `url`. */
  inputs: Record<string, unknown>;
  /** One record per uploaded asset, exposing `uri`. Pass-through references (http(s), existing storage URIs) produce no record. */
  uploads: UploadRecord[];
}

/**
 * The client surface `prepareInputs` needs: raw `upload`, and `pipeIo` as the
 * signature source. Typed as the client's own `pipeIo` signature so
 * `PipelexApiClient` satisfies it structurally.
 */
export interface PrepareCapableClient extends UploadCapableClient {
  pipeIo(request: PipeIORequest): Promise<PipeIOResponse>;
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

/** A trimmed non-empty string, or `undefined` — the "empty is absent" rule. */
function nonEmptyString(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

/**
 * A canonical Image/Document content is a plain object carrying a `url` key.
 * A VALUE-shape helper only: it is consulted at a position the descriptor has
 * already declared a file, never as the signal that one is there.
 */
function isFileContent(node: unknown): node is Record<string, unknown> {
  return isPlainObject(node) && "url" in node;
}

/**
 * The explicit envelope: a plain object whose keys are EXACTLY `concept` and
 * `content`. Matches the runtime's `_is_explicit` (`pipelex`'s
 * `input_shaper.py`): exact keys, not a superset, so a structured-content input
 * that merely happens to carry both fields is not misread as an envelope.
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

/**
 * Descriptor-guided walk, discriminated on the node's `kind`:
 *
 * - `document` / `image` — a file position, whatever the value's shape;
 * - `object` — walk the declared `fields` by name; keys the descriptor does not
 *   name are copied through untouched;
 * - `list` — walk `item` against each element;
 * - every other kind (`text`, `prose`, `date`, `number`, `boolean`, `enum`,
 *   `unknown`) — pass through at any depth. `unknown` is the standard's escape
 *   hatch for a `Dynamic` / `Composite` input, and it is NOT interpreted: the
 *   signature declares no file there, and uploading by value shape is the defect
 *   this walk removes. A caller with such an input uploads with `uploadFile`
 *   first and passes the storage URI.
 *
 * A caller value whose shape disagrees with the node (a scalar at an `object`, a
 * non-array at a `list`) passes through for the run to reject — preparation never
 * second-guesses the signature.
 */
async function resolveNode(
  ctx: PrepareContext,
  node: InputFormItem,
  callerValue: unknown,
): Promise<unknown> {
  switch (node.kind) {
    case "document":
    case "image":
      return resolveFilePosition(ctx, callerValue);
    case "object": {
      if (!isPlainObject(callerValue)) return callerValue;
      const result: Record<string, unknown> = { ...callerValue };
      for (const field of node.fields) {
        if (Object.hasOwn(callerValue, field.name)) {
          result[field.name] = await resolveNode(ctx, field, callerValue[field.name]);
        }
      }
      return result;
    }
    case "list": {
      if (!Array.isArray(callerValue)) return callerValue;
      return Promise.all(callerValue.map((element) => resolveNode(ctx, node.item, element)));
    }
    default:
      return callerValue;
  }
}

/** The method selector, normalized: empty is absent, and exactly one must remain. */
type ResolvedSelector = { files: MthdsFileItem[] } | { method_ref: string } | { method_id: string };

/**
 * Normalize and check the three selectors. Empty is absent (`files: []`,
 * `method_ref: ""`, `method_id: "  "`), mirroring the run options' rule and the
 * Python `CrateRequestBase` normalisers, and exactly one must remain — the check
 * lives here because this helper is the one that composes the `pipeIo` call.
 * The illegal shapes are compile errors for typed callers; this backs them up for
 * untyped (JS) ones with a typed `InputPreparationError`.
 */
function resolveSelector(request: PrepareInputsRequest): ResolvedSelector {
  const raw = request as unknown as Record<string, unknown>;
  const files =
    Array.isArray(raw["files"]) && raw["files"].length > 0
      ? (raw["files"] as MthdsFileItem[])
      : undefined;
  const methodRef = nonEmptyString(raw["method_ref"]);
  const methodId = nonEmptyString(raw["method_id"]);

  const given: string[] = [];
  if (files !== undefined) given.push("`files`");
  if (methodRef !== undefined) given.push("`method_ref`");
  if (methodId !== undefined) given.push("`method_id`");

  if (given.length === 0) {
    throw new InputPreparationError(
      "Cannot prepare inputs: no method selector. Supply exactly one of `files` (an inline MTHDS " +
        "closure), `method_ref` (a published method's address) or `method_id` (a stored method's " +
        "catalog id).",
    );
  }
  if (given.length > 1) {
    throw new InputPreparationError(
      `Cannot prepare inputs: ${given.join(" and ")} were ${given.length === 2 ? "both" : "all"} ` +
        "given. Supply exactly one method " +
        "selector — `files`, `method_ref` or `method_id`.",
    );
  }
  if (files !== undefined) return { files };
  if (methodRef !== undefined) return { method_ref: methodRef };
  return { method_id: methodId as string };
}

/**
 * Normalize the caller's `pipe_ref` and refuse, before any request, the two
 * spellings preparation cannot honour. Empty is absent, so the route's selection
 * chain decides.
 *
 * - A **bare** `pipe_code` is refused because a request names a pipe by its
 *   qualified ref. The route will refuse it too once the runner's shared
 *   selection enforces that rule; until then it would resolve a bare code across
 *   domains, and preparation does not lean on that fallback.
 * - An **`alias->domain.pipe_code`** ref is refused because the alias names a
 *   dependency package's pipe, and preparation covers the method's own pipes: the
 *   crate routes do not load an address-based dependency at all. The run route
 *   takes such a ref; preparation refuses it, and that asymmetry is deliberate.
 */
function normalizePipeRef(raw: unknown): string | undefined {
  const pipeRef = nonEmptyString(raw);
  if (pipeRef === undefined) return undefined;
  if (pipeRef.includes("->")) {
    throw new InputPreparationError(
      `Cannot prepare inputs: \`pipe_ref\` "${pipeRef}" names a dependency package's pipe. ` +
        "Preparation covers the method's own pipes: name one as `domain.pipe_code`.",
    );
  }
  if (!pipeRef.includes(".")) {
    throw new InputPreparationError(
      `Cannot prepare inputs: \`pipe_ref\` must be qualified (\`domain.pipe_code\`), got the bare ` +
        `"${pipeRef}".`,
    );
  }
  return pipeRef;
}

/**
 * Ask `POST /v1/pipe-io` for the pipe and its signature, whatever the selector,
 * and hand back the valid report.
 *
 * The route runs no dry run and does not refuse a method with pending
 * signatures elsewhere: preparation needs a pipe's DECLARED inputs, and whether
 * the method runs is the run's verdict, not preparation's. The `is_valid: false`
 * arm means the closure does not load, which is a preparation failure. So is a
 * selection the route refuses — an unknown `pipe_ref`, no entry pipe, several —
 * which it answers with a `422` typed by one of {@link PIPE_SELECTION_ERROR_TYPES};
 * every other failure is re-thrown unchanged.
 */
async function fetchSignature(
  client: PrepareCapableClient,
  selector: ResolvedSelector,
  pipeRef: string | undefined,
): Promise<PipeIOValidReport> {
  const request: PipeIORequest =
    pipeRef === undefined ? { ...selector } : { ...selector, pipe_ref: pipeRef };
  let result: PipeIOResponse;
  try {
    result = await client.pipeIo(request);
  } catch (error) {
    if (
      error instanceof ApiResponseError &&
      error.status === 422 &&
      error.errorType !== undefined &&
      PIPE_SELECTION_ERROR_TYPES.has(error.errorType)
    ) {
      const detail = error.serverMessage ?? error.message;
      throw new InputPreparationError(`Cannot prepare inputs: ${detail}`, { cause: error });
    }
    throw error;
  }

  if (!result.is_valid) {
    const first = result.validation_errors[0]?.message ?? result.message;
    throw new InputPreparationError(
      `Cannot prepare inputs: the method signature did not resolve — ${first}`,
    );
  }
  return result;
}

/**
 * The descriptor of the pipe the route selected. The route answers a
 * single-pipe request with `input_form` keyed by exactly the `pipe_ref` it
 * resolved, so a missing ref or a missing key is the answer contradicting itself
 * — preparing any other pipe would silently walk the wrong signature.
 */
function selectedDescriptor(report: PipeIOValidReport): PipeInputFormDescriptor {
  const pipeRef = nonEmptyString(report.pipe_ref);
  const inputForm: unknown = report.input_form;
  if (pipeRef === undefined || !isPlainObject(inputForm) || !Object.hasOwn(inputForm, pipeRef)) {
    const described = isPlainObject(inputForm)
      ? Object.keys(inputForm).join(", ") || "none"
      : "none";
    throw new InputPreparationError(
      `Cannot prepare inputs: the pipe I/O answer selected ${pipeRef === undefined ? "no pipe" : `"${pipeRef}"`}, ` +
        `but its \`input_form\` does not describe it (it describes: ${described}).`,
    );
  }
  return (inputForm as InputForm)[pipeRef] as PipeInputFormDescriptor;
}

/**
 * Prepare a pipe's inputs: upload local/byte/data-URL assets at the signature's
 * file-bearing positions and return copy-on-write rewritten inputs plus upload
 * records. HTTP(S) URLs and existing `pipelex-storage://` URIs pass through
 * unchanged. All failures are raised before any run is created.
 *
 * The pipe and its signature come from one `POST /v1/pipe-io`, whatever the
 * selector — inline `files`, a `method_ref` the runner resolves, or a
 * `method_id` the platform resolves. A bare or alias-qualified `pipe_ref`, a
 * closure that does not load, and a selection the route refuses (an unknown
 * `pipe_ref`, no entry pipe, several) throw {@link InputPreparationError}; any
 * other failure from the route (a malformed selector, an unknown or foreign-org
 * id, no package at the address, auth, a server fault, a deployment that does not
 * serve the route) surfaces as `ApiResponseError`, unchanged.
 */
export async function prepareInputs(
  client: PrepareCapableClient,
  request: PrepareInputsRequest,
): Promise<PreparedInputs> {
  const selector = resolveSelector(request);
  const pipeRef = normalizePipeRef(request.pipe_ref);
  const report = await fetchSignature(client, selector, pipeRef);
  const descriptor = selectedDescriptor(report);

  const declared = new Map<string, InputFormTopLevelField>(
    descriptor.fields.map((field) => [field.name, field]),
  );

  const ctx: PrepareContext = { client, uploads: [], dedup: new Map() };
  const rewritten: Record<string, unknown> = { ...request.inputs };
  for (const [name, callerValue] of Object.entries(request.inputs)) {
    const field = declared.get(name);
    if (field === undefined) {
      continue; // Not a declared input — pass through untouched, as today.
    }
    if (isExplicitEnvelope(callerValue)) {
      // The caller filled the explicit `{ concept, content }` envelope: walk the
      // inner content against the same node, then re-wrap so the concept
      // annotation rides through to the run (the runtime accepts the envelope).
      const walked = await resolveNode(ctx, field, callerValue.content);
      rewritten[name] = { ...callerValue, content: walked };
    } else {
      rewritten[name] = await resolveNode(ctx, field, callerValue);
    }
  }

  return { inputs: rewritten, uploads: ctx.uploads };
}
