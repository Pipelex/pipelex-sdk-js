/**
 * `prepareInputs` — signature-driven input preparation. Resolves the target
 * pipe's declared inputs from the **input-form descriptor** on the validate
 * report, interprets the caller's inputs top-down against it, uploads the
 * file-bearing values, and returns rewritten inputs (canonical content carrying
 * `pipelex-storage://` in `url`) plus one upload record per prepared asset.
 *
 * The method is named the same three ways every other method-taking operation
 * takes it — inline `files`, a `method_ref` address, or a stored `method_id` —
 * exactly one per call. All three are pass-throughs to `POST /v1/validate`,
 * which resolves an address on the runner and an id on the platform, so nothing
 * is expanded client-side.
 *
 * Per input, the caller may submit EITHER the **compact** value (a bare source /
 * canonical `{url}` content) OR the explicit `{ concept, content }` envelope —
 * its `content` is interpreted exactly as the compact value would be, and the
 * envelope is preserved on output (the `concept` annotation rides through; the
 * runtime accepts it — see `pipelex`'s `input_shaper.py` `_is_explicit` /
 * `input_normalizer.py`).
 *
 * **The descriptor is the classifier, never the value's shape.** `input_form`
 * (the MTHDS standard's artifact, opted into with `views: ["input_form"]`)
 * states the kind at every depth — `document` / `image` mark a file position,
 * `object` recurses through `fields`, `list` through `item`, everything else
 * passes through. That is what makes an OPTIONAL nested file field prepare like
 * a required one, and a `text` field merely *named* `url` stay untouched: both
 * were misread while the signature came from the rendered inputs template, whose
 * file signal was a `url`-bearing dict. See `docs/input-preparation.md` and the
 * shared behavior matrix (`wip/upload/behavior-matrix.md`).
 */

import type {
  InputForm,
  InputFormItem,
  InputFormTopLevelField,
  PipeInputFormDescriptor,
} from "mthds/protocol";
import { InputPreparationError } from "./errors.js";
import type {
  MthdsFileItem,
  PipelexValidationReport,
  PipelexValidationResult,
  ValidateMethodSelector,
} from "./models.js";
import type { UploadCapableClient, UploadRecord } from "./upload.js";
import { uploadFile } from "./upload.js";

const PIPELEX_STORAGE_SCHEME = "pipelex-storage://";
const HTTP_URL_RE = /^https?:\/\//i;

/** The shared half of the request: the target pipe and the caller's inputs. */
export interface PrepareInputsBase {
  /**
   * The pipe to prepare inputs for, as a QUALIFIED `domain.pipe_code` ref. Omit
   * it to default — see "Pipe selection" in `docs/input-preparation.md`. A bare
   * `pipe_code` is refused: the descriptor is keyed by qualified refs, and search
   * is a run-route affordance this helper deliberately does not grow. So is an
   * `alias->domain.pipe_code` ref: the alias names a dependency package's pipe,
   * which the descriptor does not describe (it covers the method's own pipes).
   */
  pipe_ref?: string;
  /** The caller's inputs (variable name → value), compact or explicit-envelope per input. */
  inputs: Record<string, unknown>;
}

/**
 * How the method is named — exactly one of the three selectors, each pinning the
 * other two to `never` so a second one is a compile error (the same XOR
 * `ValidateMethodSelector` states for the tooling routes). All three reach the
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
 * The client surface `prepareInputs` needs: raw `upload`, and `validate` as the
 * signature source. Typed as the client's own `validate` signature so
 * `PipelexApiClient` satisfies it structurally.
 */
export interface PrepareCapableClient extends UploadCapableClient {
  validate(
    source: string[] | ValidateMethodSelector,
    allowSignatures?: boolean,
    mthdsSources?: string[],
    render?: string[],
    views?: string[],
    options?: { timeoutMs?: number; signal?: AbortSignal },
  ): Promise<PipelexValidationResult>;
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
        if (field.name in callerValue) {
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
 * lives here because this helper is the one that composes the `validate` call.
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
      `Cannot prepare inputs: ${given.join(" and ")} were both given. Supply exactly one method ` +
        "selector — `files`, `method_ref` or `method_id`.",
    );
  }
  if (files !== undefined) return { files };
  if (methodRef !== undefined) return { method_ref: methodRef };
  return { method_id: methodId as string };
}

/**
 * Ask `validate` for the signature, whatever the selector, and hand back the
 * valid report.
 *
 * `allowSignatures: true` on purpose: preparation needs a pipe's DECLARED inputs,
 * and a bundle mid-authoring with an unresolved signature elsewhere must not be
 * refused inputs for a pipe whose inputs are declared. Whether the bundle runs is
 * the run's verdict, not preparation's. The `is_valid: false` arm still means the
 * closure does not load, which is a preparation failure.
 */
async function fetchSignature(
  client: PrepareCapableClient,
  selector: ResolvedSelector,
): Promise<PipelexValidationReport> {
  let result: PipelexValidationResult;
  if ("files" in selector) {
    const contents = selector.files.map((file) => file.content);
    // `validateFiles`' rule: label every content once any file names a source, so
    // the server never sees a length-mismatched `mthds_sources` array.
    const hasAnySource = selector.files.some((file) => file.source !== undefined);
    const sources = hasAnySource
      ? selector.files.map((file, index) => file.source ?? `inline://file-${index + 1}.mthds`)
      : undefined;
    result = await client.validate(contents, true, sources, undefined, ["input_form"]);
  } else {
    result = await client.validate(selector, true, undefined, undefined, ["input_form"]);
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
 * Pick the pipe whose descriptor guides the walk, in the order `docs/input-preparation.md`
 * documents: an explicit qualified `pipe_ref`, then the report's typed resolved
 * default, then the bundle's declared `main_pipe`, then the single pipe — else an
 * error naming the candidates.
 */
function selectPipeRef(
  report: PipelexValidationReport,
  inputForm: InputForm,
  requested: string | undefined,
): string {
  const refs = Object.keys(inputForm);
  const candidates = refs.length > 0 ? refs.join(", ") : "(none — the closure declares no pipes)";

  if (requested !== undefined) {
    if (!requested.includes(".")) {
      throw new InputPreparationError(
        `Cannot prepare inputs: \`pipe_ref\` must be qualified (\`domain.pipe_code\`), got the bare ` +
          `"${requested}". The method declares: ${candidates}.`,
      );
    }
    if (!(requested in inputForm)) {
      throw new InputPreparationError(
        `Cannot prepare inputs: the method declares no pipe "${requested}". It declares: ${candidates}.`,
      );
    }
    return requested;
  }

  // The typed resolved default, when the runner serves it (manifest-aware for a
  // `method_ref` package, which is why it outranks the blueprint read below).
  const typedDefault = nonEmptyString(report.default_pipe_ref);
  if (typedDefault !== undefined && typedDefault in inputForm) return typedDefault;

  // `bundle_blueprint` is opaque transport in this SDK on purpose, so read it
  // defensively and fall through rather than trust it.
  const blueprintDefault = readBlueprintMainPipeRef(report.bundle_blueprint);
  if (blueprintDefault !== undefined && blueprintDefault in inputForm) return blueprintDefault;

  if (refs.length === 1) return refs[0] as string;

  throw new InputPreparationError(
    `Cannot prepare inputs: the method declares no single default pipe, so \`pipe_ref\` is required. ` +
      `It declares: ${candidates}.`,
  );
}

/**
 * The bundle blueprint's declared `main_pipe`, qualified by its `domain` when it
 * is authored bare. Every read is defensive: the blueprint is typed
 * `Record<string, unknown>` because its schema is the runtime's, not this SDK's.
 */
function readBlueprintMainPipeRef(blueprint: unknown): string | undefined {
  if (!isPlainObject(blueprint)) return undefined;
  const mainPipe = nonEmptyString(blueprint["main_pipe"]);
  if (mainPipe === undefined) return undefined;
  if (mainPipe.includes(".")) return mainPipe;
  const domain = nonEmptyString(blueprint["domain"]);
  return domain === undefined ? undefined : `${domain}.${mainPipe}`;
}

/**
 * Prepare a pipe's inputs: upload local/byte/data-URL assets at the signature's
 * file-bearing positions and return copy-on-write rewritten inputs plus upload
 * records. HTTP(S) URLs and existing `pipelex-storage://` URIs pass through
 * unchanged. All failures are raised before any upload and before any run exists.
 *
 * The signature comes from one `POST /v1/validate` with `views: ["input_form"]`,
 * whatever the selector — inline `files`, a `method_ref` the runner resolves, or
 * a `method_id` the platform resolves. A closure that does not load, an unknown
 * `pipe_ref`, no default pipe, or a report with no descriptor throw
 * {@link InputPreparationError}; a no-verdict condition from the route (a
 * malformed selector, an unknown or foreign-org id, no package at the address,
 * auth, a server fault) surfaces as `ApiResponseError`, unchanged.
 */
export async function prepareInputs(
  client: PrepareCapableClient,
  request: PrepareInputsRequest,
): Promise<PreparedInputs> {
  const selector = resolveSelector(request);
  const report = await fetchSignature(client, selector);
  const inputForm = report.input_form;
  if (inputForm === undefined) {
    // Never a silent degrade to "no uploads": without the descriptor there is no
    // signature to prepare against.
    throw new InputPreparationError(
      "Cannot prepare inputs: the validate report carries no `input_form` descriptor — the signature " +
        'preparation reads. The descriptor rides `views: ["input_form"]` on pipelex-api >= 0.18.0; ' +
        "point the client at a runner that serves it.",
    );
  }
  const pipeRef = selectPipeRef(report, inputForm, nonEmptyString(request.pipe_ref));
  const descriptor = inputForm[pipeRef] as PipeInputFormDescriptor;

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
