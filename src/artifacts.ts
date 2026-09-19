/**
 * The artifact stack — the download twin of `prepareInputs`, in layers so each
 * operation is usable without the next:
 *
 * - {@link collectArtifacts} — a pure walk of any JSON value for the strings that
 *   ARE `pipelex-storage://` references. No network, no key.
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
 * builtins: `collectArtifacts` and `resolveArtifacts` run anywhere, `fetchArtifact`
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

/** Ceiling on collision suffixes before the never-overwrite rule gives up. */
const MAX_UNIQUE_ATTEMPTS = 10_000;

/**
 * The extension to add when the storage key has none and the resolved content
 * type is one of the artifact types a run produces. Deliberately short: an
 * unknown type simply gets no extension, never a guessed one.
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
  /** Budget for the whole exchange — connect, headers and body. Default 120 s. */
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
 * One reference's outcome in a download verdict — one shape with nullable fields,
 * like {@link ResolvedArtifact}: either `path` and `size` are set and `error` is
 * null, or `error` is set and both are null. `content_type` is the platform's
 * guess from the reference's extension, known before the fetch, on both arms.
 */
export type DownloadedArtifact =
  | {
      uri: string;
      /** Absolute path of the written file. */
      path: string;
      content_type: string | null;
      /** Bytes written. */
      size: number;
      error: null;
    }
  | {
      uri: string;
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

// ── collectArtifacts ─────────────────────────────────────────────────

/**
 * Every `pipelex-storage://` reference inside a JSON-shaped value, deduplicated,
 * in discovery order. A string counts only when it IS a reference — the whole
 * string, scheme first, with something after the scheme; text that merely
 * contains one does not. The scheme is unambiguous, so this walk is a contract
 * rather than a heuristic: the runtime serializes a produced image or document
 * as content carrying its reference in `url`, beside an expiring `public_url`
 * this walk ignores. Pure — no network, no key — so a consumer can count or
 * list a run's produced files without resolving any of them.
 */
export function collectArtifacts(value: unknown): string[] {
  const found = new Set<string>();
  walkForReferences(value, found);
  return [...found];
}

function walkForReferences(value: unknown, found: Set<string>): void {
  if (typeof value === "string") {
    if (isStorageReference(value)) found.add(value);
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) walkForReferences(item, found);
    return;
  }
  if (typeof value === "object" && value !== null) {
    for (const entry of Object.values(value)) walkForReferences(entry, found);
  }
}

/** A string that is a storage reference: the scheme, then at least one character. */
export function isStorageReference(value: string): boolean {
  return value.startsWith(PIPELEX_STORAGE_SCHEME) && value.length > PIPELEX_STORAGE_SCHEME.length;
}

// ── artifactFilename ─────────────────────────────────────────────────

/**
 * The bare filename a storage reference is saved under: the last segment of the
 * storage key, reduced to a conservative character set so it can never name
 * anything but a regular file directly inside the target directory. Path
 * separators are the split point, so no traversal survives; leading dots are
 * stripped, so no hidden file and no `..`; everything outside `[A-Za-z0-9._-]`
 * becomes `_`; an empty result falls back to a numbered `artifact-N`. Length is
 * capped with the extension preserved, and an extension is added from the
 * content type when the key carries none. A collision on disk is not this
 * function's concern: `downloadArtifacts` suffixes the stem (`name-1.ext`) on
 * exclusive creation, so a file is never overwritten.
 */
export function artifactFilename(
  uri: string,
  contentType: string | null | undefined,
  index: number,
): string {
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
    // A malformed escape sequence is kept as typed; sanitization handles it.
  }

  let name = decoded
    .replace(/[^A-Za-z0-9._-]/g, "_")
    .replace(/^[._-]+/, "")
    .replace(/[._-]+$/, "");

  if (name === "") {
    name = `artifact-${index + 1}`;
  }

  if (name.length > MAX_FILENAME_LENGTH) {
    const ext = extensionOf(name);
    // The extension is kept only if there is room left for a stem. An extension
    // at least as long as the cap would give `slice` a negative start, which
    // counts from the END and yields a name LONGER than the cap — so a
    // pathological extension is dropped rather than preserved.
    name =
      ext.length < MAX_FILENAME_LENGTH
        ? name.slice(0, MAX_FILENAME_LENGTH - ext.length) + ext
        : name.slice(0, MAX_FILENAME_LENGTH);
  }

  if (extensionOf(name) === "") {
    const ext =
      contentType == null
        ? undefined
        : EXTENSION_BY_CONTENT_TYPE[contentType.split(";")[0]!.trim().toLowerCase()];
    if (ext !== undefined) {
      name += ext;
    }
  }

  return name;
}

/** `path.extname` for a bare filename, without the `node:path` import: `.ext`, or `""` (a leading dot is not an extension). */
function extensionOf(name: string): string {
  const dot = name.lastIndexOf(".");
  return dot > 0 ? name.slice(dot) : "";
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
 * are the store's own, untouched: a proxy relaying this response sets its own
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
  const [resolved] = await resolveArtifacts(client, [uri], { signal: options.signal });
  if (resolved!.error !== null) {
    throw new ArtifactFetchError(resolved!.error.detail, uri, resolved!.error.code);
  }
  const bounds = fetchBounds(options);
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
  requirePositive("timeoutMs", timeoutMs);
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
    if (userSignal?.aborted) return err;
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

  const refusal = statusRefusal(uri, response.status);
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
    headers: response.headers,
  });
}

function statusRefusal(uri: string, status: number): ArtifactFetchError | undefined {
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
  uri: string,
  contentType: string | null,
  code: string,
  detail: string,
): DownloadedArtifact {
  return { uri, path: null, content_type: contentType, size: null, error: { code, detail } };
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
    throw new RunFailedError(state.message, runId, state.status);
  }
  return state.result;
}

/**
 * Save a run's produced files under `dir` — Node-only, like the path-string arm
 * of `uploadFile`. Takes a `run_id` (the results are re-read, so a run is
 * downloadable days later) or a `RunResults` in hand; walks the requested scope
 * with {@link collectArtifacts}; resolves the whole set through the bulk route
 * ahead of the workers; then a bounded pool of workers each fetch → open with
 * `wx` → write, re-resolving any link that has expired by the time a worker
 * reaches it. The embedded `public_url` is never used. Files are named by
 * {@link artifactFilename} and never overwritten; a failed or aborted download
 * unlinks its partial file.
 *
 * Returns a produced verdict: one entry per reference, errors as values. It
 * throws only when no verdict can be produced — `RunStillRunningError` or
 * `RunFailedError` for a run that has not completed, `ScopeUnavailableError`
 * when the scope's artifact is null or missing, `ArtifactAuthenticationError`
 * (carrying the verdict so far) when the resolve route refuses the credential,
 * `ArtifactOperationError` outside Node or for an unusable `dir`, and the
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

  const uris = collectArtifacts(walked);
  if (uris.length === 0) {
    return { scope, artifacts: [], saved_paths: [], all_saved: true };
  }

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
      (outcome, index) => outcome ?? itemError(uris[index]!, null, "aborted", SKIPPED_CREDENTIAL),
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
  // Every fetch listens to this one signal: the caller's, plus the internal stop
  // a credential failure pulls so the other workers do not keep spending it.
  const stop = new AbortController();
  const signal = request.signal ? AbortSignal.any([request.signal, stop.signal]) : stop.signal;
  const workerBounds: FetchBounds = { ...bounds, signal };
  let credentialFailure: ApiResponseError | undefined;
  let totalBytes = 0;
  let limitReached = false;
  let next = 0;

  const saveOne = async (
    index: number,
    uri: string,
    url: string,
    contentType: string | null,
  ): Promise<DownloadedArtifact> => {
    let response: Response;
    try {
      response = await fetchResolvedUrl(uri, url, workerBounds, dispatcher, () => undefined);
    } catch (err) {
      return itemError(uri, contentType, ...classifyFailure(err, signal));
    }

    const declared = Number(response.headers.get("content-length"));
    if (Number.isFinite(declared) && totalBytes + declared > maxTotalBytes) {
      limitReached = true;
      await discard(response);
      return itemError(
        uri,
        contentType,
        "total_limit_exceeded",
        `Saving this ${formatMiB(declared)} artifact would take the download past its ` +
          `${formatMiB(maxTotalBytes)} total limit.`,
      );
    }

    let target: { handle: NodeFileHandle; path: string };
    try {
      target = await openUniqueFile(fs, path, dir, artifactFilename(uri, contentType, index));
    } catch (err) {
      await discard(response);
      return itemError(
        uri,
        contentType,
        "write_failed",
        `The file could not be created: ${err instanceof Error ? err.message : String(err)}.`,
      );
    }

    const removePartial = async (): Promise<void> => {
      await target.handle.close().catch(() => undefined);
      await fs.unlink(target.path).catch(() => undefined);
    };

    let written = 0;
    if (response.body === null) {
      try {
        await target.handle.close();
      } catch (err) {
        await removePartial();
        return itemError(
          uri,
          contentType,
          "write_failed",
          `The file could not be closed: ${err instanceof Error ? err.message : String(err)}.`,
        );
      }
      return { uri, path: target.path, content_type: contentType, size: 0, error: null };
    }
    const reader = response.body.getReader();
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        if (totalBytes + value.byteLength > maxTotalBytes) {
          limitReached = true;
          await reader.cancel().catch(() => undefined);
          await removePartial();
          return itemError(
            uri,
            contentType,
            "total_limit_exceeded",
            `This artifact took the download past its ${formatMiB(maxTotalBytes)} total limit.`,
          );
        }
        totalBytes += value.byteLength;
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
          uri,
          contentType,
          "write_failed",
          `The file could not be written: ${err.message}.`,
        );
      }
      return itemError(uri, contentType, ...classifyFailure(err, signal));
    }

    try {
      await target.handle.close();
    } catch (err) {
      await removePartial();
      return itemError(
        uri,
        contentType,
        "write_failed",
        `The file could not be closed: ${err instanceof Error ? err.message : String(err)}.`,
      );
    }
    return { uri, path: target.path, content_type: contentType, size: written, error: null };
  };

  const worker = async (): Promise<void> => {
    for (;;) {
      const index = next;
      next += 1;
      if (index >= uris.length) return;
      const uri = uris[index]!;
      let entry = resolved[index]!;
      if (signal.aborted) {
        outcomes[index] = itemError(
          uri,
          entry.content_type,
          "aborted",
          credentialFailure ? SKIPPED_CREDENTIAL : SKIPPED_ABORTED,
        );
        continue;
      }
      if (limitReached) {
        outcomes[index] = itemError(uri, entry.content_type, "total_limit_exceeded", SKIPPED_TOTAL);
        continue;
      }
      if (entry.error === null && isExpired(entry.expires_at)) {
        try {
          const again = await resolveArtifacts(client, [uri], { signal });
          entry = again[0]!;
        } catch (err) {
          if (isCredentialRefusal(err)) {
            credentialFailure = err;
            stop.abort(err);
            outcomes[index] = itemError(uri, entry.content_type, "aborted", SKIPPED_CREDENTIAL);
            return;
          }
          if (signal.aborted) {
            outcomes[index] = itemError(uri, entry.content_type, "aborted", SKIPPED_ABORTED);
            continue;
          }
          outcomes[index] = itemError(
            uri,
            entry.content_type,
            "resolve_failed",
            `The expired link could not be re-resolved: ${err instanceof Error ? err.message : String(err)}.`,
          );
          continue;
        }
      }
      if (entry.error !== null) {
        outcomes[index] = itemError(uri, null, entry.error.code, entry.error.detail);
        continue;
      }
      outcomes[index] = await saveOne(index, uri, entry.url, entry.content_type);
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
      (outcome, index) => outcome ?? itemError(uris[index]!, null, "aborted", SKIPPED_ABORTED),
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
function classifyFailure(err: unknown, signal: AbortSignal): [string, string] {
  if (err instanceof ArtifactFetchError) return [err.code, err.message];
  if (signal.aborted)
    return ["aborted", "The download was aborted while this artifact was being fetched."];
  return [
    "network",
    `The artifact could not be read: ${err instanceof Error ? err.message : String(err)}.`,
  ];
}
