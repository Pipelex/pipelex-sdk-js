/**
 * The artifact stack — the download twin of `prepareInputs`, in layers so each
 * operation is usable without the next:
 *
 * - {@link locateArtifacts} — a pure walk of any JSON value for the strings that
 *   ARE `pipelex-storage://` references, each with every path it sits at.
 *   {@link collectArtifacts} is the same walk's bare references. No network, no key.
 * - {@link resolveArtifacts} — the platform's bulk resolve route over a whole
 *   list, chunked at the route's bound, one verdict per reference.
 * - {@link fetchArtifact} — a bounded `Response` for one reference: resolved
 *   fresh, timed out, redirects refused, the byte cap enforced mid-stream, no
 *   credentials forwarded, headers untouched.
 * - {@link downloadArtifacts} — Node-only: a run's produced files saved under a
 *   directory by a bounded pool of workers, as a produced verdict.
 *
 * A produced file is never embedded in a run's results: the content carries its
 * durable `pipelex-storage://` reference beside a signed `public_url` that expires
 * on the provider's schedule. Nothing here reads that embedded link — every link
 * is minted fresh by the platform, and re-minted when it has expired by the time a
 * worker reaches it. See `docs/artifact-download.md`.
 *
 * `node:fs/promises`, `node:path` and `undici` are imported dynamically, behind
 * `isNodeRuntime()`, so the module's static import graph stays free of Node
 * builtins: the walk and `resolveArtifacts` run anywhere, `fetchArtifact`
 * runs anywhere the global `fetch` does (the dispatcher is a Node refinement), and
 * only `downloadArtifacts` touches a filesystem.
 */

import type { Dispatcher } from "undici";
import {
  ApiResponseError,
  ArtifactAuthenticationError,
  ArtifactFetchError,
  ArtifactOperationError,
  RunFailedError,
  RunStillRunningError,
  ScopeUnavailableError,
} from "./errors.js";
import type { RunResults, RunResultState } from "./runs.js";
import { isNodeRuntime } from "./upload.js";
import { MAX_TIMER_DELAY_MS, isTimerDelay } from "./timers.js";

// ── Constants ────────────────────────────────────────────────────────

/** The scheme of a durable storage reference. */
export const PIPELEX_STORAGE_SCHEME = "pipelex-storage://";

/**
 * How many references one bulk resolve request takes — the route's bound, fixed
 * by the platform contract rather than configured per deployment. A longer list
 * is a `422`, so {@link resolveArtifacts} chunks at this size.
 */
export const BULK_RESOLVE_MAX_URIS = 100;

/**
 * The per-file byte cap. An accident guard against filling a disk from a
 * runaway output, not a judgment about artifact size: a produced file is
 * server-side, so a caller cannot shrink it the way they can shrink an upload.
 */
export const DEFAULT_ARTIFACT_MAX_BYTES = 1024 * 1024 * 1024;

/** The per-file budget for connecting, receiving the headers and reading the body. */
export const DEFAULT_ARTIFACT_TIMEOUT_MS = 120_000;

/** The cap on the bytes one `downloadArtifacts` call writes in total. */
export const DEFAULT_DOWNLOAD_MAX_TOTAL_BYTES = 4 * 1024 * 1024 * 1024;

/** How many artifacts one `downloadArtifacts` call has in flight at once. */
export const DEFAULT_DOWNLOAD_CONCURRENCY = 4;

/**
 * A link this close to its `expires_at` is re-resolved rather than fetched: the
 * object store checks the signature when the request arrives, and a few seconds
 * of clock skew between the platform and this process must not turn a link the
 * platform still considers live into a `403`.
 */
const EXPIRY_MARGIN_MS = 10_000;

/** Longest filename `downloadArtifacts` writes, extension included. */
const MAX_FILENAME_LENGTH = 128;

/**
 * Longest extension taken from a storage key, dot excluded. Anything longer after
 * the key's last dot is read as part of a name rather than as an extension, and
 * the content type's extension is used instead.
 */
const MAX_EXTENSION_LENGTH = 10;

/**
 * Stems Windows reserves for a device, in any case and whatever the extension:
 * `aux.png` there names the auxiliary device, not a file. A stem is a field name
 * the method author chose, so `$.aux.url` would otherwise reach one.
 */
const WINDOWS_DEVICE_STEM = /^(?:con|prn|aux|nul|com[0-9]|lpt[0-9])$/i;

/** Ceiling on collision suffixes before the never-overwrite rule gives up. */
const MAX_UNIQUE_ATTEMPTS = 10_000;

/**
 * The extension a saved file takes when its storage key carries none and the
 * resolved content type is one of the artifact types a run produces. Deliberately
 * short: an unknown type simply gets no extension, never a guessed one.
 */
const EXTENSION_BY_CONTENT_TYPE: Record<string, string> = {
  "image/png": ".png",
  "image/jpeg": ".jpg",
  "image/webp": ".webp",
  "image/gif": ".gif",
  "image/svg+xml": ".svg",
  "application/pdf": ".pdf",
  "text/plain": ".txt",
  "text/markdown": ".md",
  "text/html": ".html",
  "text/csv": ".csv",
  "application/json": ".json",
};

// ── Types ────────────────────────────────────────────────────────────

/**
 * Why one reference failed — a value, never a thrown error. `code` is the
 * resolve route's own per-reference code (`invalid_storage_uri`, `forbidden`)
 * or one of the fetch boundary's (see `ArtifactFetchError`), plus the download's
 * own `resolve_failed`, `total_limit_exceeded`, `write_failed` and `aborted`.
 * `detail` is the sentence a person reads.
 */
export interface ArtifactItemError {
  code: string;
  detail: string;
}

/**
 * One reference's resolution — the bulk resolve route's item, verbatim. Either
 * the link fields are set and `error` is null, or `error` is set and the three
 * link fields are null. A consumer branches on `error`, never on an HTTP status:
 * the request was a `200` whenever every reference got a verdict.
 */
export type ResolvedArtifact =
  | {
      /** The reference exactly as sent. */
      uri: string;
      /** A presigned link, fetchable now and for about fifteen minutes. */
      url: string;
      /** UTC expiry of the link, ISO 8601. */
      expires_at: string;
      /** The platform's content-type guess from the reference's extension; null when it has none. */
      content_type: string | null;
      error: null;
    }
  | {
      uri: string;
      url: null;
      expires_at: null;
      content_type: null;
      error: ArtifactItemError;
    };

/** The wire request of `POST /v1/resolve-storage-url/bulk` — at most {@link BULK_RESOLVE_MAX_URIS} references. */
export interface BulkResolveStorageUrlsInput {
  uris: string[];
}

/** The wire response of `POST /v1/resolve-storage-url/bulk` — one item per requested reference, in request order. */
export interface BulkResolvedStorageUrls {
  items: ResolvedArtifact[];
}

/** The bounds `fetchArtifact` applies. Every one has a safe default. */
export interface FetchArtifactOptions {
  /** Refuse (before a byte is written) and cut (mid-stream) a body over this many bytes. Default 1 GiB. */
  maxBytes?: number;
  /**
   * Budget for the whole exchange — connect, headers and body. Default 120 s. At most
   * 2147483647, the longest delay a timer honours.
   */
  timeoutMs?: number;
  /**
   * Accept a plain `http:` link. Off by default: a general-purpose library does
   * not fetch over plain http silently. The local compose stack's object store
   * hands out such links, which is the case this opts into.
   */
  allowHttp?: boolean;
  /** Cancels the fetch; a body being read is cancelled too. */
  signal?: AbortSignal;
}

/** Which of a run's artifacts `downloadArtifacts` walks for references. */
export type ArtifactScope = "main_stuff" | "working_memory";

/** The options shared by both forms of a `downloadArtifacts` request. */
export interface DownloadArtifactsOptions extends FetchArtifactOptions {
  /** The directory to save under, created if missing. Files are never overwritten. */
  dir: string;
  /**
   * `main_stuff` (the default) walks the run's main output. `working_memory` is
   * the opt-in that also brings down the echoed inputs and every intermediate.
   */
  scope?: ArtifactScope;
  /** How many artifacts are in flight at once. Default 4. */
  concurrency?: number;
  /**
   * Cap on the bytes written by the whole call. Default 4 GiB. The item that would
   * cross it is an item error, and the items not yet started are skipped with the
   * same reason.
   */
  maxTotalBytes?: number;
}

/**
 * What `downloadArtifacts` takes: the options plus exactly one of `run_id` (the
 * results are re-read, so this works days after the run) or `results` (a
 * `RunResults` already in hand, read as it is). The type pins the other to
 * `never`, so naming both is a compile error.
 */
export type DownloadArtifactsRequest = DownloadArtifactsOptions &
  ({ run_id: string; results?: never } | { results: RunResults; run_id?: never });

/**
 * Where one `pipelex-storage://` reference sits in a walked value — what
 * {@link locateArtifacts} answers per reference. `found_at` lists every path at
 * which the reference occurs, in walk order, and is never empty: `found_at[0]` is
 * where it was first seen, and the path a saved file is named after.
 *
 * A path is `$`-rooted: `$` is the walked value itself, an object key matching
 * `^[A-Za-z_][A-Za-z0-9_]*$` is `.key`, any other key is `["…"]` in JSON string
 * escaping, and an array index is `[n]` — `$.rooms[3].staged_photo.url`,
 * `$.items[0].url`, `$["a key"].url`. It is the exact path of the string, the
 * final `url` of a content object included.
 */
export interface ArtifactLocation {
  /** The reference, exactly as it appears in the walked value. */
  uri: string;
  /** Every `$`-rooted path at which the reference occurs, in walk order. */
  found_at: string[];
}

/**
 * One reference's outcome in a download verdict — one shape with nullable fields,
 * like {@link ResolvedArtifact}: either `path` and `size` are set and `error` is
 * null, or `error` is set and both are null. `found_at` says where the reference
 * sits in the walked scope, and `content_type` is the platform's guess from the
 * reference's extension, known before the fetch; both are on both arms, so an
 * item that was not saved still says which field it would have filled.
 */
export type DownloadedArtifact =
  | {
      uri: string;
      /** Every `$`-rooted path in the walked scope where the reference sits; the first one named the file. */
      found_at: string[];
      /** Absolute path of the written file. */
      path: string;
      content_type: string | null;
      /** Bytes written. */
      size: number;
      error: null;
    }
  | {
      uri: string;
      /** Every `$`-rooted path in the walked scope where the reference sits. */
      found_at: string[];
      path: null;
      content_type: string | null;
      size: null;
      error: ArtifactItemError;
    };

/**
 * The produced verdict of `downloadArtifacts`. `artifacts.length` is the count
 * of references walked, errors included; an empty list over a present scope is
 * a verdict ("this output references no stored file"), not an error.
 */
export interface DownloadArtifactsResult {
  scope: ArtifactScope;
  /** One entry per reference, in discovery order. */
  artifacts: DownloadedArtifact[];
  /** The absolute paths of the files saved, in the same order. */
  saved_paths: string[];
  /** True when every walked reference was saved — vacuously true for an empty walk. */
  all_saved: boolean;
  /** Present, and true, only when the caller's `signal` aborted the call. */
  aborted?: true;
}

/**
 * The client surface the artifact operations need: the raw bulk resolve call and
 * the single-shot result lookup. Typed as the client's own signatures so
 * `PipelexApiClient` satisfies it structurally, and so tests inject a fake.
 */
export interface ArtifactCapableClient {
  resolveStorageUrls(
    input: BulkResolveStorageUrlsInput,
    options?: { signal?: AbortSignal },
  ): Promise<BulkResolvedStorageUrls>;
  getRunResult(runId: string, options?: { signal?: AbortSignal }): Promise<RunResultState>;
}

// ── locateArtifacts / collectArtifacts ───────────────────────────────

/** One step of a path into a walked value: an object key, or an array index. */
type PathSegment = string | number;

/**
 * A reference as the walk records it: the raw segments of every path it was
 * found at. `downloadArtifacts` names its files from these segments directly, so
 * it never parses a rendered path back; `found_at` is only their rendering.
 */
interface LocatedReference {
  uri: string;
  paths: PathSegment[][];
}

/** An object key rendered as `.key` in a path; any other key is rendered as `["…"]`. */
const IDENTIFIER_KEY = /^[A-Za-z_][A-Za-z0-9_]*$/;

/**
 * Every `pipelex-storage://` reference inside a JSON-shaped value, each with
 * every path at which it occurs. The references are deduplicated and kept in
 * discovery order (the order of their first sighting), and each one's `found_at`
 * lists its paths in walk order, so `found_at[0]` is where it was first seen.
 *
 * The string test is {@link collectArtifacts}'s: a string counts only when it IS
 * a reference. A path is rooted at `$`, the walked value itself; an object key
 * matching `^[A-Za-z_][A-Za-z0-9_]*$` is written `.key`, any other key `["…"]` in
 * JSON string escaping, and an array index `[n]`. The runtime serializes a
 * produced image or document as content carrying its reference in `url`, so a
 * typical path ends there: `$.rooms[3].staged_photo.url`, `$.items[0].url`, or
 * `$.url` for an output that is one image. Pure — no network, no key.
 */
export function locateArtifacts(value: unknown): ArtifactLocation[] {
  return walkReferences(value).map(renderLocation);
}

/**
 * Every `pipelex-storage://` reference inside a JSON-shaped value, deduplicated,
 * in discovery order — the references of {@link locateArtifacts}, without their
 * paths. A string counts only when it IS a reference — the whole string, scheme
 * first, with something after the scheme; text that merely contains one does
 * not. The scheme is unambiguous, so this walk is a contract rather than a
 * heuristic: the runtime serializes a produced image or document as content
 * carrying its reference in `url`, beside an expiring `public_url` this walk
 * ignores. Pure — no network, no key — so a consumer can count or list a run's
 * produced files without resolving any of them.
 */
export function collectArtifacts(value: unknown): string[] {
  return walkReferences(value, false).map((located) => located.uri);
}

/**
 * The walk both public functions share: depth first, keys in `Object.entries`
 * order. With `withPaths` off it records each reference once and no path at
 * all, which is what `collectArtifacts` needs: copying the trail for every
 * occurrence costs memory in proportion to occurrences times depth, where the
 * deduplicated list needs only one entry per unique reference.
 */
function walkReferences(value: unknown, withPaths = true): LocatedReference[] {
  // A Map keeps insertion order, which is the order of first sighting.
  const byUri = new Map<string, LocatedReference>();
  const trail: PathSegment[] = [];
  const visit = (node: unknown): void => {
    if (typeof node === "string") {
      if (!isStorageReference(node)) return;
      const known = byUri.get(node);
      if (!withPaths) {
        if (known === undefined) byUri.set(node, { uri: node, paths: [] });
        return;
      }
      const path = [...trail];
      if (known === undefined) byUri.set(node, { uri: node, paths: [path] });
      else known.paths.push(path);
      return;
    }
    if (Array.isArray(node)) {
      for (let index = 0; index < node.length; index += 1) {
        trail.push(index);
        visit(node[index]);
        trail.pop();
      }
      return;
    }
    if (typeof node === "object" && node !== null) {
      for (const [key, entry] of Object.entries(node)) {
        trail.push(key);
        visit(entry);
        trail.pop();
      }
    }
  };
  visit(value);
  return [...byUri.values()];
}

function renderLocation(located: LocatedReference): ArtifactLocation {
  return { uri: located.uri, found_at: located.paths.map(renderPath) };
}

/** Segments to the `$`-rooted notation `found_at` carries. */
function renderPath(segments: readonly PathSegment[]): string {
  let path = "$";
  for (const segment of segments) {
    if (typeof segment === "number") path += `[${segment}]`;
    else if (IDENTIFIER_KEY.test(segment)) path += `.${segment}`;
    else path += `[${JSON.stringify(segment)}]`;
  }
  return path;
}

/**
 * The `$`-rooted notation back to segments, for a location that reaches
 * {@link artifactFilename} from outside the walk. The rendering is lossless, so
 * this is exact for every path the walk produced; anything else is `undefined`.
 */
function parsePath(path: string): PathSegment[] | undefined {
  if (!path.startsWith("$")) return undefined;
  const segments: PathSegment[] = [];
  let at = 1;
  while (at < path.length) {
    const rest = path.slice(at);
    const key = /^\.([A-Za-z_][A-Za-z0-9_]*)/.exec(rest);
    if (key !== null) {
      segments.push(key[1]!);
      at += key[0].length;
      continue;
    }
    const index = /^\[(\d+)\]/.exec(rest);
    if (index !== null) {
      segments.push(Number(index[1]));
      at += index[0].length;
      continue;
    }
    const quoted = /^\[("(?:[^"\\]|\\.)*")\]/s.exec(rest);
    if (quoted === null) return undefined;
    try {
      segments.push(JSON.parse(quoted[1]!) as string);
    } catch {
      return undefined;
    }
    at += quoted[0].length;
  }
  return segments;
}

/** A string that is a storage reference: the scheme, then at least one character. */
export function isStorageReference(value: string): boolean {
  return value.startsWith(PIPELEX_STORAGE_SCHEME) && value.length > PIPELEX_STORAGE_SCHEME.length;
}

// ── artifactFilename ─────────────────────────────────────────────────

/**
 * The bare filename a reference is saved under, named after the field it fills:
 * the path in `location.found_at[0]`, where the reference was first seen.
 *
 * 1. A final object key `url` is dropped, since the runtime's image and
 *    document contents carry their reference there; a reference under any other
 *    key keeps that key, and a `url` key that is not final is kept.
 * 2. Each key is reduced to `[A-Za-z0-9_]`, every other character (`-` and `.`
 *    included) becoming `_`; an index stays its decimal digits.
 * 3. The segments are joined with `-`. An empty result — the reference is the
 *    walked value itself, or its `url` — becomes the scope's name.
 * 4. Over the filename length cap (`MAX_FILENAME_LENGTH`, extension included),
 *    the tail is kept: whole leading segments are dropped first, since the last
 *    ones are the specific ones, and a single segment still too long is cut to
 *    fit.
 * 5. A stem Windows reserves for a device (`con`, `prn`, `aux`, `nul`,
 *    `com0`–`com9`, `lpt0`–`lpt9`, in any case) gets a trailing `_`, so
 *    `$.aux.url` is saved as `aux_.png`.
 * 6. The extension is the storage key's own, reduced to `[A-Za-z0-9]`, when it
 *    has a short one; otherwise the content type's, for the types a run
 *    produces; otherwise there is none.
 *
 * So `$.rooms[3].staged_photo.url` is saved as `rooms-3-staged_photo.png`, and
 * `$.url` in `main_stuff` as `main_stuff.png`. The stem is ASCII letters, digits,
 * `_` and the `-` joins, never empty and never a device name, so the name can
 * only ever be a regular file directly inside the target directory. A collision on disk is not this
 * function's concern: `downloadArtifacts` suffixes the stem (`name-1.ext`) on
 * exclusive creation, so a file is never overwritten.
 *
 * Throws `ArtifactOperationError` for a location whose `found_at[0]` is not a path
 * in the notation {@link locateArtifacts} writes, or for an unknown scope.
 */
export function artifactFilename(
  location: ArtifactLocation,
  contentType: string | null | undefined,
  scope: ArtifactScope,
): string {
  requireScope(scope);
  // A JavaScript caller can hand anything here — the old signature's bare uri
  // string among them — and every shape must reach the documented refusal
  // rather than a TypeError, or a string's first character.
  const loose = location as { uri?: unknown; found_at?: unknown } | null | undefined;
  const uri: unknown = loose?.uri;
  if (typeof uri !== "string") {
    throw new ArtifactOperationError(
      `artifactFilename needs a location carrying its reference as a string "uri"; got ${String(uri)}.`,
    );
  }
  const foundAt: unknown = loose?.found_at;
  const first: unknown = Array.isArray(foundAt) ? foundAt[0] : undefined;
  const segments = typeof first === "string" ? parsePath(first) : undefined;
  if (segments === undefined) {
    throw new ArtifactOperationError(
      `artifactFilename needs a location whose first "found_at" entry is a path such as ` +
        `"$.items[0].url"; got ${typeof first === "string" ? JSON.stringify(first) : String(first)}.`,
    );
  }
  return filenameFor(segments, uri, contentType, scope);
}

/** The naming rule of {@link artifactFilename}, over the walk's own segments. */
function filenameFor(
  segments: readonly PathSegment[],
  uri: string,
  contentType: string | null | undefined,
  scope: ArtifactScope,
): string {
  const named = segments.at(-1) === "url" ? segments.slice(0, -1) : segments;
  const words = named
    .map((segment) =>
      typeof segment === "number" ? String(segment) : segment.replace(/[^A-Za-z0-9_]/gu, "_"),
    )
    // Only the empty key reduces to nothing, and it says nothing about the field.
    .filter((word) => word !== "");
  const extension = extensionFor(uri, contentType);
  const stem = fitStem(words.length > 0 ? words : [scope], MAX_FILENAME_LENGTH - extension.length);
  // A device stem is at most four characters, so the `_` cannot overrun the cap.
  return (WINDOWS_DEVICE_STEM.test(stem) ? `${stem}_` : stem) + extension;
}

/** The words joined with `-` within `budget` characters, keeping the tail. */
function fitStem(words: readonly string[], budget: number): string {
  let start = 0;
  let length = words.reduce((sum, word) => sum + word.length, 0) + words.length - 1;
  while (length > budget && start < words.length - 1) {
    length -= words[start]!.length + 1;
    start += 1;
  }
  const stem = words.slice(start).join("-");
  return stem.length > budget ? stem.slice(0, budget) : stem;
}

/** `.ext` for the saved file — the storage key's own, else the content type's — or `""`. */
function extensionFor(uri: string, contentType: string | null | undefined): string {
  const fromKey = storageKeyExtension(uri);
  if (fromKey !== "") return `.${fromKey}`;
  if (contentType == null) return "";
  return EXTENSION_BY_CONTENT_TYPE[contentType.split(";")[0]!.trim().toLowerCase()] ?? "";
}

/**
 * The extension the storage key's last segment carries, without its dot, reduced
 * to `[A-Za-z0-9]` — or `""` when it has none, or none that short. The segment is
 * what follows the last `/` or `\` once the scheme, query and fragment are gone,
 * percent-decoded when it decodes; a leading dot is not an extension.
 */
function storageKeyExtension(uri: string): string {
  const key = uri.startsWith(PIPELEX_STORAGE_SCHEME)
    ? uri.slice(PIPELEX_STORAGE_SCHEME.length)
    : uri;
  const segment =
    (key.split(/[?#]/)[0] ?? "")
      .split(/[\\/]/)
      .filter((part) => part !== "")
      .pop() ?? "";

  let decoded = segment;
  try {
    decoded = decodeURIComponent(segment);
  } catch {
    // A malformed escape sequence is kept as typed; the reduction handles it.
  }

  const dot = decoded.lastIndexOf(".");
  if (dot <= 0) return "";
  const extension = decoded.slice(dot + 1).replace(/[^A-Za-z0-9]/g, "");
  return extension.length <= MAX_EXTENSION_LENGTH ? extension : "";
}

/** `path.extname` for a bare filename, without the `node:path` import: `.ext`, or `""` (a leading dot is not an extension). */
function extensionOf(name: string): string {
  const dot = name.lastIndexOf(".");
  return dot > 0 ? name.slice(dot) : "";
}

function requireScope(scope: unknown): asserts scope is ArtifactScope {
  if (scope !== "main_stuff" && scope !== "working_memory") {
    throw new ArtifactOperationError(
      `"scope" must be "main_stuff" or "working_memory", got ${String(scope)}.`,
    );
  }
}

// ── resolveArtifacts ─────────────────────────────────────────────────

/**
 * Resolve a list of references through the bulk route, chunked at
 * {@link BULK_RESOLVE_MAX_URIS} per request, and answer one
 * {@link ResolvedArtifact} per reference in request order, duplicates included.
 * Per-reference failure is a value on the item; only what is not about a
 * reference throws — the route's whole-request refusals as `ApiResponseError`
 * (a caller with no organization, a malformed request, a signing failure, or a
 * `404` from a deployment that does not serve the route) and an unreachable
 * host as `ApiUnreachableError`. An empty list resolves to an empty list with
 * no request made.
 */
export async function resolveArtifacts(
  client: Pick<ArtifactCapableClient, "resolveStorageUrls">,
  uris: string[],
  options: { signal?: AbortSignal } = {},
): Promise<ResolvedArtifact[]> {
  const items: ResolvedArtifact[] = [];
  for (let start = 0; start < uris.length; start += BULK_RESOLVE_MAX_URIS) {
    const chunk = uris.slice(start, start + BULK_RESOLVE_MAX_URIS);
    const answer = await client.resolveStorageUrls({ uris: chunk }, { signal: options.signal });
    const resolved = answer?.items;
    if (!Array.isArray(resolved) || resolved.length !== chunk.length) {
      throw new ArtifactOperationError(
        `The bulk resolve route answered ${Array.isArray(resolved) ? resolved.length : "no"} ` +
          `item(s) for ${chunk.length} reference(s) — a malformed answer, so no reference can be ` +
          "matched to its verdict.",
      );
    }
    items.push(...resolved);
  }
  return items;
}

// ── fetchArtifact ────────────────────────────────────────────────────

/**
 * A bounded `Response` for one reference: the link is minted fresh through the
 * bulk route, then fetched with `redirect: "manual"` (a presigned link has no
 * reason to redirect, and one that does is refused rather than followed), no
 * headers of ours (the link carries its own authorization in the query string,
 * and nothing must ride along to the object store), a budget covering the
 * headers and the body, and a byte cap checked against `Content-Length` before
 * a byte is read and again on every chunk. The status, status text and headers
 * are the store's own, except that a `Content-Encoding` the fetch already decoded
 * is dropped with the encoded `Content-Length`: a proxy relaying this response sets its own
 * `Content-Disposition`, `X-Content-Type-Options`, CSP and caching headers,
 * because this function does not.
 *
 * Only a `2xx` is returned. Anything else is thrown as `ArtifactFetchError`
 * with a `code` (a redirect, a refused or vanished object, a store fault, a
 * declared oversize, a timeout, a network fault, an unusable link, or the
 * route's own per-reference refusal); a body that crosses the cap mid-stream
 * errors the returned stream with the same error type (`too_large`). The
 * caller's abort propagates as-is. Whole-request failures of the resolve step
 * propagate unchanged (`ApiResponseError`, `ApiUnreachableError`).
 */
export async function fetchArtifact(
  client: Pick<ArtifactCapableClient, "resolveStorageUrls">,
  uri: string,
  options: FetchArtifactOptions = {},
): Promise<Response> {
  const bounds = fetchBounds(options);
  const [resolved] = await resolveArtifacts(client, [uri], { signal: options.signal });
  if (resolved!.error !== null) {
    throw new ArtifactFetchError(resolved!.error.detail, uri, resolved!.error.code);
  }
  const dispatcher = await dispatcherFor(bounds.timeoutMs);
  return fetchResolvedUrl(uri, resolved!.url, bounds, dispatcher, () => {
    void dispatcher?.close().catch(() => undefined);
  });
}

/** The bounds every fetch runs under, defaults filled in and validated. */
interface FetchBounds {
  maxBytes: number;
  timeoutMs: number;
  allowHttp: boolean;
  signal: AbortSignal | undefined;
}

function fetchBounds(options: FetchArtifactOptions): FetchBounds {
  const maxBytes = options.maxBytes ?? DEFAULT_ARTIFACT_MAX_BYTES;
  const timeoutMs = options.timeoutMs ?? DEFAULT_ARTIFACT_TIMEOUT_MS;
  requirePositive("maxBytes", maxBytes);
  // A longer delay overflows the timer, which then fires at once as a false timeout.
  if (!isTimerDelay(timeoutMs)) {
    throw new ArtifactOperationError(
      `"timeoutMs" must be a positive number no larger than ${MAX_TIMER_DELAY_MS}, got ` +
        `${String(timeoutMs)}.`,
    );
  }
  return { maxBytes, timeoutMs, allowHttp: options.allowHttp ?? false, signal: options.signal };
}

function requirePositive(name: string, value: number): void {
  if (!Number.isFinite(value) || value <= 0) {
    throw new ArtifactOperationError(`"${name}" must be a positive number, got ${String(value)}.`);
  }
}

/**
 * The undici dispatcher a fetch runs on, carrying `headersTimeout` and
 * `bodyTimeout` — the per-stall bounds that the overall `AbortSignal` budget
 * does not give: an abort cancels the request, but a socket stalled mid-body
 * is only reclaimed by the dispatcher's own timers. Null outside Node, or when
 * `undici` cannot be loaded, in which case the fetch runs on the platform's
 * default dispatcher with only the budget applied.
 */
async function dispatcherFor(timeoutMs: number): Promise<Dispatcher | null> {
  if (!isNodeRuntime()) return null;
  try {
    const { Agent } = await import("undici");
    return new Agent({ headersTimeout: timeoutMs, bodyTimeout: timeoutMs });
  } catch {
    return null;
  }
}

/** The parsed, boundary-approved URL — the object the fetch then uses verbatim. */
function checkUrl(uri: string, downloadUrl: string, allowHttp: boolean): URL {
  let url: URL;
  try {
    url = new URL(downloadUrl);
  } catch {
    throw new ArtifactFetchError(
      "The platform resolved the reference to a link that is not a valid absolute URL.",
      uri,
      "unsupported_url",
    );
  }
  if (url.protocol === "http:" && !allowHttp) {
    throw new ArtifactFetchError(
      "The platform resolved the reference to a plain http link, which is refused by default; " +
        "pass allowHttp: true to accept it (the local stack's object store hands out such links).",
      uri,
      "plain_http_refused",
    );
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new ArtifactFetchError(
      `The platform resolved the reference to a "${url.protocol.replace(":", "")}" link, which is not fetched; ` +
        "only http(s) links are.",
      uri,
      "unsupported_url",
    );
  }
  if (url.username !== "" || url.password !== "") {
    throw new ArtifactFetchError(
      "The platform resolved the reference to a link carrying credentials, which is not fetched.",
      uri,
      "unsupported_url",
    );
  }
  return url;
}

/**
 * The bounded fetch of an already-resolved link — the half of `fetchArtifact`
 * that `downloadArtifacts` shares, its links coming from one bulk resolve ahead
 * of the workers. `release` runs exactly once, when the exchange is over: the
 * response refused, the body fully read, errored or cancelled.
 */
async function fetchResolvedUrl(
  uri: string,
  downloadUrl: string,
  bounds: FetchBounds,
  dispatcher: Dispatcher | null,
  release: () => void,
): Promise<Response> {
  let url: URL;
  try {
    url = checkUrl(uri, downloadUrl, bounds.allowHttp);
  } catch (err) {
    release();
    throw err;
  }

  const controller = new AbortController();
  const userSignal = bounds.signal;
  let timedOut = false;
  let released = false;
  // Runs exactly once, on every way the exchange can end — including the two
  // aborts, so a returned body nobody ever reads still releases its resources.
  // It closes over `timer`, declared below: nothing can call it before that
  // declaration has run, since both aborts fire asynchronously.
  const releaseOnce = (): void => {
    if (released) return;
    released = true;
    clearTimeout(timer);
    userSignal?.removeEventListener("abort", onUserAbort);
    release();
  };
  const onUserAbort = (): void => {
    controller.abort(userSignal?.reason);
    releaseOnce();
  };
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort(new DOMException("The artifact fetch timed out.", "TimeoutError"));
    releaseOnce();
  }, bounds.timeoutMs);
  if (userSignal) {
    if (userSignal.aborted) controller.abort(userSignal.reason);
    else userSignal.addEventListener("abort", onUserAbort, { once: true });
  }
  const failure = (err: unknown): unknown => {
    if (timedOut) {
      return new ArtifactFetchError(
        `Fetching the artifact timed out after ${bounds.timeoutMs}ms.`,
        uri,
        "timeout",
        undefined,
        { cause: err },
      );
    }
    // The caller's reason, not `err`: a browser rejects the fetch, and errors a body
    // cut short, with a generic AbortError rather than the signal's reason.
    if (userSignal?.aborted) return userSignal.reason;
    if (err instanceof ArtifactFetchError) return err;
    return new ArtifactFetchError(
      `The artifact could not be fetched: ${err instanceof Error ? err.message : String(err)}.`,
      uri,
      "network",
      undefined,
      { cause: err },
    );
  };

  if (controller.signal.aborted) {
    // Already aborted before the request: the same outcome `fetch` would give,
    // settled here so it does not depend on the platform's fetch checking first.
    releaseOnce();
    throw failure(controller.signal.reason);
  }

  let response: Response;
  try {
    const init: RequestInit & { dispatcher?: Dispatcher } = {
      redirect: "manual",
      cache: "no-store",
      signal: controller.signal,
    };
    if (dispatcher !== null) init.dispatcher = dispatcher;
    response = await fetch(url, init);
  } catch (err) {
    releaseOnce();
    throw failure(err);
  }

  const refusal = statusRefusal(uri, response);
  if (refusal !== undefined) {
    await discard(response);
    releaseOnce();
    throw refusal;
  }

  const declared = Number(response.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > bounds.maxBytes) {
    await discard(response);
    releaseOnce();
    throw new ArtifactFetchError(
      `The artifact is ${formatMiB(declared)}, over the ${formatMiB(bounds.maxBytes)} cap.`,
      uri,
      "too_large",
      response.status,
    );
  }

  if (response.body === null) {
    releaseOnce();
    return response;
  }

  const upstream = response.body.getReader();
  // The body reader is cancelled on abort explicitly, on top of the request's
  // own abort, so an abandoned stream never waits on the store's next chunk.
  controller.signal.addEventListener(
    "abort",
    () => {
      void upstream.cancel(controller.signal.reason).catch(() => undefined);
    },
    { once: true },
  );
  let total = 0;
  const bounded = new ReadableStream<Uint8Array>({
    async pull(streamController) {
      let chunk: ReadableStreamReadResult<Uint8Array>;
      try {
        chunk = await upstream.read();
      } catch (err) {
        releaseOnce();
        streamController.error(failure(err));
        return;
      }
      if (chunk.done) {
        releaseOnce();
        // Cancelling the upstream reader on abort resolves a pending read as
        // `done`, not as a rejection — so an end-of-stream that arrives while
        // aborted is the abort, never a clean close that would pass a truncated
        // body off as complete.
        if (controller.signal.aborted) {
          streamController.error(failure(controller.signal.reason));
        } else {
          streamController.close();
        }
        return;
      }
      total += chunk.value.byteLength;
      if (total > bounds.maxBytes) {
        await upstream.cancel().catch(() => undefined);
        releaseOnce();
        streamController.error(
          new ArtifactFetchError(
            `The artifact crossed the ${formatMiB(bounds.maxBytes)} cap mid-stream.`,
            uri,
            "too_large",
            response.status,
          ),
        );
        return;
      }
      streamController.enqueue(chunk.value);
    },
    async cancel(reason) {
      releaseOnce();
      await upstream.cancel(reason).catch(() => undefined);
    },
  });

  return new Response(bounded, {
    status: response.status,
    statusText: response.statusText,
    headers: decodedHeaders(response.headers),
  });
}

/**
 * The codings every runtime's `fetch` decodes. `zstd` is left out: whether it is
 * decoded depends on the runtime (Node 22's zlib has none), and a coding fetch
 * did not decode must keep its header, since the bytes are still encoded.
 */
const FETCH_DECODED_CODINGS = new Set(["gzip", "x-gzip", "deflate", "br"]);

/**
 * The store's headers as they describe the body we hand on. When `fetch` has
 * decoded every coding the `Content-Encoding` lists, the stream is the decoded
 * bytes: the encoding and the encoded length are dropped, or a proxy relaying
 * the response would label plain bytes as compressed and give the wrong length.
 * Any other encoding is passed through with the still-encoded body it describes.
 */
function decodedHeaders(headers: Headers): Headers {
  const codings = (headers.get("content-encoding") ?? "")
    .split(",")
    .map((coding) => coding.trim().toLowerCase())
    .filter((coding) => coding !== "" && coding !== "identity");
  if (codings.length === 0 || !codings.every((coding) => FETCH_DECODED_CODINGS.has(coding))) {
    return headers;
  }
  const decoded = new Headers(headers);
  decoded.delete("content-encoding");
  decoded.delete("content-length");
  return decoded;
}

function statusRefusal(uri: string, response: Response): ArtifactFetchError | undefined {
  const status = response.status;
  // A browser hands a manual redirect back as an opaque-redirect response, whose
  // status is 0 and says nothing; Node's fetch hands back the 3xx itself.
  if (response.type === "opaqueredirect") {
    return new ArtifactFetchError(
      "The resolved link redirected; redirects are not followed.",
      uri,
      "redirect_refused",
    );
  }
  if (status >= 300 && status < 400) {
    return new ArtifactFetchError(
      `The resolved link redirected (HTTP ${status}); redirects are not followed.`,
      uri,
      "redirect_refused",
      status,
    );
  }
  // The link is minted per call, so a 401/403 is the store refusing a fresh
  // signature (clock skew, a signing misconfiguration) rather than an expired link.
  if (status === 401 || status === 403) {
    return new ArtifactFetchError(
      `The object store refused the resolved link (HTTP ${status}).`,
      uri,
      "store_refused",
      status,
    );
  }
  if (status === 404 || status === 410) {
    return new ArtifactFetchError(
      `The stored file is no longer available (HTTP ${status}).`,
      uri,
      "not_found",
      status,
    );
  }
  if (status < 200 || status >= 300) {
    return new ArtifactFetchError(
      `The object store answered HTTP ${status} for the resolved link.`,
      uri,
      "store_error",
      status,
    );
  }
  return undefined;
}

/** Release a response we are refusing, so its connection is not left dangling. */
async function discard(response: Response): Promise<void> {
  try {
    await response.body?.cancel();
  } catch {
    // Discarding a body we already refused is best-effort; nothing to report.
  }
}

function formatMiB(bytes: number): string {
  const mib = bytes / (1024 * 1024);
  return `${Number.isInteger(mib) ? mib : mib.toFixed(1)} MiB`;
}

// ── downloadArtifacts ────────────────────────────────────────────────

/** The write side of a streamed download: what {@link writeFully} needs of a `FileHandle`. */
export interface ChunkWriter {
  write(buffer: Uint8Array, offset: number, length: number): Promise<{ bytesWritten: number }>;
}

/**
 * Write the whole chunk, looping on short writes. `FileHandle.write()` resolves
 * with the count it managed, which can fall short of the chunk on a filesystem
 * under pressure; taking one call as "written" would report a truncated file
 * as saved.
 */
export async function writeFully(writer: ChunkWriter, chunk: Uint8Array): Promise<void> {
  let offset = 0;
  while (offset < chunk.byteLength) {
    const { bytesWritten } = await writer.write(chunk, offset, chunk.byteLength - offset);
    if (bytesWritten <= 0) {
      throw new Error(
        `the filesystem accepted no bytes at offset ${offset} of ${chunk.byteLength}`,
      );
    }
    offset += bytesWritten;
  }
}

/** The slice of `node:fs/promises` the download needs, loaded once per call. */
interface NodeFs {
  mkdir(path: string, options: { recursive: true }): Promise<string | undefined>;
  open(path: string, flags: string): Promise<NodeFileHandle>;
  unlink(path: string): Promise<void>;
}

interface NodeFileHandle extends ChunkWriter {
  close(): Promise<void>;
}

interface NodePath {
  resolve(...segments: string[]): string;
  join(...segments: string[]): string;
}

/**
 * Create `baseName` under `dir` exclusively (`wx`), suffixing the stem
 * (`name-1.ext`, `name-2.ext`, …) until a free name is found. Exclusive creation
 * is what makes "never overwrite" true rather than merely likely: an
 * exists-check followed by a write would race a concurrent worker.
 */
async function openUniqueFile(
  fs: NodeFs,
  path: NodePath,
  dir: string,
  baseName: string,
): Promise<{ handle: NodeFileHandle; path: string }> {
  const ext = extensionOf(baseName);
  const stem = baseName.slice(0, baseName.length - ext.length);
  for (let attempt = 0; attempt < MAX_UNIQUE_ATTEMPTS; attempt += 1) {
    const candidate = path.join(dir, attempt === 0 ? baseName : `${stem}-${attempt}${ext}`);
    try {
      return { handle: await fs.open(candidate, "wx"), path: candidate };
    } catch (err) {
      if ((err as { code?: string }).code !== "EEXIST") throw err;
    }
  }
  throw new Error(`Could not find a free filename for ${baseName} in ${dir}.`);
}

/** A write to the target file failed — tagged so it reports as `write_failed`, not as a transport fault. */
class ArtifactWriteError extends Error {
  readonly inner: unknown;

  constructor(inner: unknown) {
    super(inner instanceof Error ? inner.message : String(inner));
    this.name = "ArtifactWriteError";
    this.inner = inner;
  }
}

/** The download stopped before this item was attempted. */
const SKIPPED_ABORTED = "The download was aborted before this artifact was fetched.";
const SKIPPED_CREDENTIAL =
  "The download stopped on a credential failure before this artifact was fetched.";
const SKIPPED_TOTAL =
  "Skipped: the download's total byte limit was reached by an earlier artifact.";

function itemError(
  location: ArtifactLocation,
  contentType: string | null,
  code: string,
  detail: string,
): DownloadedArtifact {
  return {
    uri: location.uri,
    found_at: location.found_at,
    path: null,
    content_type: contentType,
    size: null,
    error: { code, detail },
  };
}

function isExpired(expiresAt: string): boolean {
  const at = Date.parse(expiresAt);
  return Number.isFinite(at) && at - EXPIRY_MARGIN_MS <= Date.now();
}

function isCredentialRefusal(err: unknown): err is ApiResponseError {
  return err instanceof ApiResponseError && (err.status === 401 || err.status === 403);
}

/** Read a run's results by id, turning a run that has not completed into its typed error. */
async function readCompletedResults(
  client: Pick<ArtifactCapableClient, "getRunResult">,
  runId: string,
  signal: AbortSignal | undefined,
): Promise<RunResults> {
  const state = await client.getRunResult(runId, { signal });
  if (state.state === "running") {
    throw new RunStillRunningError(
      `Run ${runId} is still running, so it has no artifacts to download yet` +
        (state.retry_after_seconds != null ? ` — retry in ${state.retry_after_seconds}s.` : "."),
      runId,
      state.retry_after_seconds,
    );
  }
  if (state.state === "failed") {
    throw new RunFailedError(state.message, runId, state.status, { error: state.error });
  }
  return state.result;
}

/**
 * Save a run's produced files under `dir` — Node-only, like the path-string arm
 * of `uploadFile`. Takes a `run_id` (the results are re-read, so a run is
 * downloadable days later) or a `RunResults` in hand; walks the requested scope
 * with {@link locateArtifacts}; resolves the whole set through the bulk route
 * ahead of the workers; then a bounded pool of workers each fetch → open with
 * `wx` → write, re-resolving any link that has expired by the time a worker
 * reaches it. The embedded `public_url` is never used. Each file is named after
 * the field it fills, by {@link artifactFilename}'s rule, and never overwritten;
 * a failed or aborted download unlinks its partial file.
 *
 * Returns a produced verdict: one entry per reference, errors as values. It
 * throws only when no verdict can be produced — `RunStillRunningError` or
 * `RunFailedError` for a run that has not completed, `ScopeUnavailableError`
 * when the scope's artifact is null or missing, `ArtifactAuthenticationError`
 * (carrying the verdict so far) when the resolve route refuses the credential,
 * `ArtifactOperationError` outside Node, for an unusable `dir` or for an
 * unknown `scope`, and the
 * transport and lifecycle errors of the reads it makes (`ApiResponseError` for
 * a deployment without the bulk route, `RunLifecycleUnavailableError` for a
 * bare runner asked by id, `ApiUnreachableError`).
 */
export async function downloadArtifacts(
  client: ArtifactCapableClient,
  request: DownloadArtifactsRequest,
): Promise<DownloadArtifactsResult> {
  if (!isNodeRuntime()) {
    throw new ArtifactOperationError(
      "downloadArtifacts writes to a filesystem and is Node-only. In another runtime, resolve " +
        "with resolveArtifacts or stream with fetchArtifact instead.",
    );
  }
  const scope = request.scope ?? "main_stuff";
  requireScope(scope);
  const concurrency = request.concurrency ?? DEFAULT_DOWNLOAD_CONCURRENCY;
  const maxTotalBytes = request.maxTotalBytes ?? DEFAULT_DOWNLOAD_MAX_TOTAL_BYTES;
  if (!Number.isInteger(concurrency) || concurrency < 1) {
    throw new ArtifactOperationError(
      `"concurrency" must be a positive integer, got ${String(concurrency)}.`,
    );
  }
  requirePositive("maxTotalBytes", maxTotalBytes);
  const bounds = fetchBounds(request);

  const hasRunId = typeof request.run_id === "string" && request.run_id !== "";
  const hasResults = request.results != null;
  if (hasRunId === hasResults) {
    throw new ArtifactOperationError(
      "downloadArtifacts takes exactly one of `run_id` (the results are re-read) or `results` " +
        "(a RunResults in hand).",
    );
  }
  const results = hasResults
    ? request.results!
    : await readCompletedResults(client, request.run_id!, request.signal);
  const runId = results.pipeline_run_id;

  // `working_memory` is read off the parsed body: the platform relays it whether
  // or not `RunResults` declares the field.
  const walked =
    scope === "main_stuff"
      ? results.main_stuff
      : (results as unknown as Record<string, unknown>)["working_memory"];
  if (walked == null) {
    throw new ScopeUnavailableError(scope, runId);
  }

  // The walk's own record names the files; `locations` is what the verdict reports.
  const located = walkReferences(walked);
  if (located.length === 0) {
    return { scope, artifacts: [], saved_paths: [], all_saved: true };
  }
  const locations = located.map(renderLocation);
  const uris = located.map((reference) => reference.uri);

  const fs = (await import("node:fs/promises")) as unknown as NodeFs;
  const path = (await import("node:path")) as unknown as NodePath;
  const dir = path.resolve(request.dir);
  try {
    await fs.mkdir(dir, { recursive: true });
  } catch (cause) {
    throw new ArtifactOperationError(
      `The download directory "${dir}" cannot be created or used: ${cause instanceof Error ? cause.message : String(cause)}.`,
      { cause },
    );
  }

  // Dense, never sparse: `map` skips the holes of `new Array(n)`, and the verdict
  // must name every reference, reached or not.
  const outcomes: (DownloadedArtifact | undefined)[] = Array.from(
    { length: uris.length },
    () => undefined,
  );
  const verdictSoFar = (): DownloadArtifactsResult => {
    const artifacts = outcomes.map(
      (outcome, index) =>
        outcome ?? itemError(locations[index]!, null, "aborted", SKIPPED_CREDENTIAL),
    );
    return assembleVerdict(scope, artifacts, request.signal?.aborted === true);
  };

  let resolved: ResolvedArtifact[];
  try {
    resolved = await resolveArtifacts(client, uris, { signal: request.signal });
  } catch (err) {
    if (isCredentialRefusal(err)) {
      throw new ArtifactAuthenticationError(
        `The resolve route refused the credential (${err.status}); no artifact was downloaded.`,
        err.status,
        verdictSoFar(),
        { cause: err },
      );
    }
    throw err;
  }

  // One dispatcher for the whole batch, so the workers share connections to the
  // store; closed once every worker has settled.
  const dispatcher = await dispatcherFor(bounds.timeoutMs);
  const signal = request.signal;
  // A call, not a property read: the flag flips across an await, so it must not be narrowed.
  const aborted = (): boolean => signal?.aborted === true;
  const workerBounds: FetchBounds = { ...bounds, signal };
  // A credential refusal on a re-resolve stops the workers taking new items, and
  // nothing else: a fetch already running is on a presigned link that does not
  // carry the credential, so it is left to finish and its file is kept.
  let credentialFailure: ApiResponseError | undefined;
  // What the total cap is held against: the bytes of every file saved or being
  // saved, a file in flight counting as the larger of its declared length and
  // what it has written. Reserving the declared length up front is what stops
  // parallel files from each passing the check and then all being cut together;
  // a file that is unlinked gives its share back.
  let committedBytes = 0;
  // The bytes of the files saved so far. The limit is reached for good, and the
  // items not yet started skipped, only when these leave no room: a refusal
  // against another file's reservation is that item's alone, since the file in
  // flight may still fail and give its share back.
  let savedBytes = 0;
  let limitReached = false;
  let next = 0;

  const saveOne = async (
    index: number,
    url: string,
    contentType: string | null,
  ): Promise<DownloadedArtifact> => {
    const location = locations[index]!;
    const uri = location.uri;
    let response: Response;
    try {
      response = await fetchResolvedUrl(uri, url, workerBounds, dispatcher, () => undefined);
    } catch (err) {
      return itemError(location, contentType, ...classifyFailure(err, signal));
    }

    const declaredLength = Number(response.headers.get("content-length"));
    const reserved = Number.isFinite(declaredLength) ? declaredLength : 0;
    if (committedBytes + reserved > maxTotalBytes) {
      if (savedBytes + reserved > maxTotalBytes) limitReached = true;
      await discard(response);
      return itemError(
        location,
        contentType,
        "total_limit_exceeded",
        `Saving this ${formatMiB(reserved)} artifact would take the download past its ` +
          `${formatMiB(maxTotalBytes)} total limit.`,
      );
    }
    committedBytes += reserved;
    let written = 0;
    const share = (): number => Math.max(written, reserved);

    let target: { handle: NodeFileHandle; path: string };
    try {
      const filename = filenameFor(located[index]!.paths[0]!, uri, contentType, scope);
      target = await openUniqueFile(fs, path, dir, filename);
    } catch (err) {
      committedBytes -= share();
      await discard(response);
      return itemError(
        location,
        contentType,
        "write_failed",
        `The file could not be created: ${err instanceof Error ? err.message : String(err)}.`,
      );
    }

    const removePartial = async (): Promise<void> => {
      committedBytes -= share();
      await target.handle.close().catch(() => undefined);
      await fs.unlink(target.path).catch(() => undefined);
    };

    if (response.body === null) {
      try {
        await target.handle.close();
      } catch (err) {
        await removePartial();
        return itemError(
          location,
          contentType,
          "write_failed",
          `The file could not be closed: ${err instanceof Error ? err.message : String(err)}.`,
        );
      }
      committedBytes -= share();
      return {
        uri,
        found_at: location.found_at,
        path: target.path,
        content_type: contentType,
        size: 0,
        error: null,
      };
    }
    const reader = response.body.getReader();
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        // Only the bytes past this file's reservation are new to the total.
        const growth = Math.max(written + value.byteLength, reserved) - share();
        if (committedBytes + growth > maxTotalBytes) {
          if (savedBytes + written + value.byteLength > maxTotalBytes) limitReached = true;
          await reader.cancel().catch(() => undefined);
          await removePartial();
          return itemError(
            location,
            contentType,
            "total_limit_exceeded",
            `This artifact took the download past its ${formatMiB(maxTotalBytes)} total limit.`,
          );
        }
        committedBytes += growth;
        written += value.byteLength;
        try {
          await writeFully(target.handle, value);
        } catch (err) {
          throw new ArtifactWriteError(err);
        }
      }
    } catch (err) {
      await reader.cancel().catch(() => undefined);
      await removePartial();
      if (err instanceof ArtifactWriteError) {
        return itemError(
          location,
          contentType,
          "write_failed",
          `The file could not be written: ${err.message}.`,
        );
      }
      return itemError(location, contentType, ...classifyFailure(err, signal));
    }

    try {
      await target.handle.close();
    } catch (err) {
      await removePartial();
      return itemError(
        location,
        contentType,
        "write_failed",
        `The file could not be closed: ${err instanceof Error ? err.message : String(err)}.`,
      );
    }
    // A body shorter than it declared gives the unused reservation back.
    committedBytes -= share() - written;
    savedBytes += written;
    return {
      uri,
      found_at: location.found_at,
      path: target.path,
      content_type: contentType,
      size: written,
      error: null,
    };
  };

  const worker = async (): Promise<void> => {
    for (;;) {
      const index = next;
      next += 1;
      if (index >= uris.length) return;
      const location = locations[index]!;
      let entry = resolved[index]!;
      if (credentialFailure !== undefined || aborted()) {
        outcomes[index] = itemError(
          location,
          entry.content_type,
          "aborted",
          credentialFailure ? SKIPPED_CREDENTIAL : SKIPPED_ABORTED,
        );
        continue;
      }
      if (limitReached) {
        outcomes[index] = itemError(
          location,
          entry.content_type,
          "total_limit_exceeded",
          SKIPPED_TOTAL,
        );
        continue;
      }
      if (entry.error === null && isExpired(entry.expires_at)) {
        try {
          const again = await resolveArtifacts(client, [location.uri], { signal });
          entry = again[0]!;
        } catch (err) {
          if (isCredentialRefusal(err)) {
            credentialFailure = err;
            outcomes[index] = itemError(
              location,
              entry.content_type,
              "aborted",
              SKIPPED_CREDENTIAL,
            );
            continue;
          }
          if (aborted()) {
            outcomes[index] = itemError(location, entry.content_type, "aborted", SKIPPED_ABORTED);
            continue;
          }
          outcomes[index] = itemError(
            location,
            entry.content_type,
            "resolve_failed",
            `The expired link could not be re-resolved: ${err instanceof Error ? err.message : String(err)}.`,
          );
          continue;
        }
      }
      if (entry.error !== null) {
        outcomes[index] = itemError(location, null, entry.error.code, entry.error.detail);
        continue;
      }
      outcomes[index] = await saveOne(index, entry.url, entry.content_type);
    }
  };

  try {
    await Promise.all(Array.from({ length: Math.min(concurrency, uris.length) }, worker));
  } finally {
    void dispatcher?.close().catch(() => undefined);
  }

  if (credentialFailure) {
    throw new ArtifactAuthenticationError(
      `The resolve route refused the credential (${credentialFailure.status}) part-way through ` +
        "the download; the verdict so far is on this error.",
      credentialFailure.status,
      verdictSoFar(),
      { cause: credentialFailure },
    );
  }

  return assembleVerdict(
    scope,
    outcomes.map(
      (outcome, index) => outcome ?? itemError(locations[index]!, null, "aborted", SKIPPED_ABORTED),
    ),
    request.signal?.aborted === true,
  );
}

function assembleVerdict(
  scope: ArtifactScope,
  artifacts: DownloadedArtifact[],
  aborted: boolean,
): DownloadArtifactsResult {
  const saved_paths = artifacts.flatMap((artifact) =>
    artifact.error === null ? [artifact.path] : [],
  );
  const verdict: DownloadArtifactsResult = {
    scope,
    artifacts,
    saved_paths,
    all_saved: saved_paths.length === artifacts.length,
  };
  if (aborted) verdict.aborted = true;
  return verdict;
}

/** An item's `[code, detail]` for an error thrown while fetching or reading it. */
function classifyFailure(err: unknown, signal: AbortSignal | undefined): [string, string] {
  if (err instanceof ArtifactFetchError) return [err.code, err.message];
  if (signal?.aborted === true)
    return ["aborted", "The download was aborted while this artifact was being fetched."];
  return [
    "network",
    `The artifact could not be read: ${err instanceof Error ? err.message : String(err)}.`,
  ];
}
