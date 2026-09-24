/**
 * `uploadWithGrant` — send one file straight to Pipelex storage with an upload
 * grant (`PipelexApiClient.requestUploadGrant`, `POST /v1/upload/grant`). The
 * side that holds the credential requests the grant; the side that holds the
 * bytes, typically a browser page, sends them with this. See
 * `docs/input-preparation.md`.
 *
 * **This module is the browser-safe entry, `@pipelex/sdk/upload`.** Its runtime
 * import graph must never reach a Node builtin, `undici` or the client: a page
 * bundles it as is, with nothing marked external. It imports the error classes,
 * the timer bound in `timers.ts` and the wire types only, and
 * `tests/upload-grant.test.ts` bundles it for the browser with esbuild to hold it
 * to that.
 */

import { InputPreparationError, RejectedAssetError, UploadTransportError } from "./errors.js";
import type { RejectedAssetCode } from "./errors.js";
import type { UploadGrant } from "./product-models.js";
import { MAX_TIMER_DELAY_MS, isTimerDelay } from "./timers.js";

export type { UploadGrant, UploadGrantInput } from "./product-models.js";
// The classes `uploadWithGrant` raises, so a page can branch on them without the main entry.
export { InputPreparationError, RejectedAssetError, UploadTransportError } from "./errors.js";
export type { RejectedAssetCode, UploadTransportCode } from "./errors.js";

/**
 * The default time limit on the `PUT`: a minute to open the exchange and hear back,
 * plus a second for every started 128 KiB of the file, about 1 Mbit/s — 460 s at the
 * 50 MiB cap. The grant's expiry bounds nothing here: storage checks the signature
 * when the request starts, not when it ends.
 */
const DEFAULT_TIMEOUT_BASE_MS = 60_000;
const DEFAULT_TIMEOUT_BYTES_PER_SECOND = 128 * 1024;

/**
 * How much of storage's error body is read. S3 writes `<Code>` and `<Message>` first,
 * and the longest document this meets, a signature mismatch echoing the canonical
 * request, runs to a few kilobytes after them.
 */
const ERROR_BODY_MAX_BYTES = 16 * 1024;

/** Per-call options for {@link uploadWithGrant}. */
export interface UploadWithGrantOptions {
  /**
   * Cancels the upload. A caller's abort propagates as the signal's own reason,
   * never wrapped, so it stays distinguishable from a failure. It ends the upload
   * whenever it fires, so it can shorten the time limit but never lengthen it.
   */
  signal?: AbortSignal;
  /**
   * The time limit on the whole exchange with storage, in milliseconds, replacing
   * the default of 60 s plus 1 s for every started 128 KiB of the file — about
   * 1 Mbit/s, so 460 s for a 50 MiB file. Pass a longer one for a slower link. It
   * must be a positive number no larger than 2147483647, the longest delay a timer
   * honours.
   */
  timeoutMs?: number;
}

/** What a successful {@link uploadWithGrant} stored. */
export interface GrantedUpload {
  /** The grant's `pipelex-storage://` reference, which now names the stored object. */
  uri: string;
}

/**
 * `PUT` a file to storage with an upload grant, and return the reference it now
 * carries. The file goes as the raw body with the grant's signed headers
 * unchanged; the body sets `Content-Length`, which the grant signed, so the file
 * must be exactly the size the grant was requested for.
 *
 * Storage's refusals map onto the input-preparation errors, so a caller that
 * already handles `uploadFile` needs no new case:
 *
 * - `RejectedAssetError` (`status` is storage's, `code` says why) — a `412` when
 *   the grant was already used (`grant_used`: a grant writes one object, once); a
 *   `403` when the file's size, type or metadata differ from what the grant signed
 *   (`signature_mismatch`), when the request carried a header the grant did not sign
 *   (`unsigned_header`), or when the grant has expired (`grant_expired`); any other
 *   `4xx` (`store_refused`). Each asks for a new grant, or for the file the grant
 *   was requested for.
 * - `UploadTransportError` (`status` is storage's when it answered, `code` says
 *   which) — the time limit running out (`timeout`), storage unreachable
 *   (`unreachable`), a `5xx` (`server_error`), storage timing out on the body
 *   (`storage_timeout`, a `400 RequestTimeout`, which wrote nothing), another upload
 *   with the same grant still in progress (`conflict`, a `409
 *   ConditionalRequestConflict`), or a redirect, which is refused rather than
 *   followed (`redirected`). In a browser a refused cross-origin request looks like
 *   an unreachable host, so the message names that too. A grant whose `url` is not
 *   an absolute `http(s)` URL free of user info is refused the same way, before
 *   anything is sent (`invalid_grant_url`).
 *
 * The whole exchange runs under a time limit: `timeoutMs` when given, else 60 s plus
 * 1 s for every started 128 KiB of the file. A caller's `signal` can end it sooner,
 * and its abort propagates as the signal's own reason, unwrapped, even when the time
 * limit ran out too. Only the first 16 KiB of storage's error body are read, and when
 * the limit runs out while that body is still arriving, storage has already answered:
 * the call settles as that answer, classified from its status and whatever part of the
 * body arrived.
 *
 * A timeout, a `5xx`, a conflict and a connection lost after the file went out leave
 * it unknown whether the object was written: retrying with the same grant before it
 * expires either stores it or answers the `412` of a used grant, and then the
 * grant's `uri` already names the file. The grant is a bearer capability: nothing
 * here logs it, and no error this throws carries its URL, storage's error body or a
 * runtime error that could hold either.
 */
export async function uploadWithGrant(
  grant: UploadGrant,
  file: Blob,
  options: UploadWithGrantOptions = {},
): Promise<GrantedUpload> {
  const label = fileLabel(grant, file);
  const { signal, timeoutMs } = options;
  // A caller's abort wins over a grant or an option this would refuse, as it does over a
  // failed request.
  if (signal?.aborted) throw signal.reason;
  if (timeoutMs !== undefined) requireTimeout(timeoutMs);
  const limitMs = timeoutMs ?? defaultTimeoutMs(file.size);
  const target = storageTarget(grant, label);

  // The call's own controller carries both ways the exchange can be cut short: the
  // caller's signal, forwarded into it, and the time limit, which also covers reading
  // storage's error body.
  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort(new DOMException("The upload timed out.", "TimeoutError"));
  }, limitMs);
  const onCallerAbort = (): void => controller.abort(signal?.reason);
  signal?.addEventListener("abort", onCallerAbort, { once: true });

  try {
    let response: Response;
    try {
      response = await fetch(grant.url, {
        method: "PUT",
        headers: grant.headers,
        body: file,
        // A presigned URL signs its host, so a redirect could never succeed; refusing
        // it keeps the file from being sent anywhere the grant did not name.
        redirect: "manual",
        signal: controller.signal,
      });
    } catch (error) {
      // The signals' outcome, not the runtime's error: some runtimes reject with a generic
      // AbortError instead of the reason. A caller's abort wins over the time limit, since
      // it is the one the caller can see and act on.
      if (signal?.aborted) throw signal.reason;
      if (timedOut) throw timeoutError(label, limitMs, grant);
      // Neither the runtime's message nor the error itself is kept: either can carry the
      // request URL, and with it the grant's credential (Bun puts it on the error's `path`).
      throw new UploadTransportError(
        `Upload of "${label}" could not reach storage at ${target.origin} ` +
          `(${describeNetworkFailure(error)}). In a browser, a refused cross-origin request ` +
          "looks the same: check that the page may connect to the storage origin (its CSP " +
          "connect-src). If the connection failed after the file went out, storage may have " +
          `stored it anyway. ${sameGrantRetry(grant)}`,
        { code: "unreachable" },
      );
    }

    // A body is cancelled, never awaited: a stream's cancel can outlive any time limit.
    if (response.status >= 200 && response.status < 300) {
      void response.body?.cancel().catch(() => undefined);
      return { uri: grant.uri };
    }
    // A browser reports a refused redirect as an opaque response with status 0.
    if (response.type === "opaqueredirect" || (response.status >= 300 && response.status < 400)) {
      void response.body?.cancel().catch(() => undefined);
      throw new UploadTransportError(
        `Upload of "${label}" was redirected by storage, and the redirect was refused: a ` +
          "presigned upload is valid only at the URL it was signed for.",
        // A refused redirect in a browser is opaque, with status 0: no status reached us.
        { status: response.status || undefined, code: "redirected" },
      );
    }

    // Only the error's code and message are kept, never the body: S3 echoes the
    // canonical request on a signature mismatch, and with it the grant's credential.
    const body = await readErrorPrefix(response, ERROR_BODY_MAX_BYTES, controller.signal);
    // A caller's abort while the body streams stays the caller's, unwrapped. The time limit
    // running out then is no timeout: storage has answered, and its status says what
    // happened, read with whatever part of the body arrived.
    if (signal?.aborted) throw signal.reason;
    const refusal = parseStorageError(body);
    const status = response.status;
    if (status === 400 && refusal.code === "RequestTimeout") {
      throw new UploadTransportError(
        `Upload of "${label}" timed out at storage (${describeStatus(response, refusal)}): ` +
          "storage stopped waiting for the file's bytes and wrote nothing. Retry with the same " +
          `grant before it expires at ${grant.expires_at}, or with a new one.`,
        { status, code: "storage_timeout" },
      );
    }
    // S3 answers this when two create-only PUTs for one key overlap, and documents it as
    // retryable: it says nothing about this file, so it is no refusal of it.
    if (status === 409 && refusal.code === "ConditionalRequestConflict") {
      throw new UploadTransportError(
        `Upload of "${label}" met another upload with the same grant still in progress at ` +
          `storage (${describeStatus(response, refusal)}), so whether the file was stored is ` +
          `unknown. Send a grant once at a time. ${sameGrantRetry(grant)}`,
        { status, code: "conflict" },
      );
    }
    if (status >= 400 && status < 500) {
      const { code, advice } = classifyRefusal(status, refusal, grant);
      throw new RejectedAssetError(
        `Storage refused the upload of "${label}" (${describeStatus(response, refusal)}): ${advice}`,
        label,
        status,
        { code },
      );
    }
    throw new UploadTransportError(
      `Upload of "${label}" failed at storage (${describeStatus(response, refusal)})` +
        (refusal.message ? `: ${withoutFinalPeriod(refusal.message)}` : "") +
        `. Whether the file was stored is unknown. ${sameGrantRetry(grant)}`,
      { status, code: status >= 500 ? "server_error" : "unexpected" },
    );
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", onCallerAbort);
  }
}

/** The default time limit for a file of `size` bytes, capped at what a timer honours. */
function defaultTimeoutMs(size: number): number {
  const seconds = Math.ceil(size / DEFAULT_TIMEOUT_BYTES_PER_SECOND);
  return Math.min(DEFAULT_TIMEOUT_BASE_MS + seconds * 1_000, MAX_TIMER_DELAY_MS);
}

/** A caller's `timeoutMs`, refused before anything is sent when no timer could honour it. */
function requireTimeout(timeoutMs: number): void {
  if (!isTimerDelay(timeoutMs)) {
    throw new InputPreparationError(
      `"timeoutMs" must be a positive number no larger than ${MAX_TIMER_DELAY_MS}, got ` +
        `${String(timeoutMs)}.`,
    );
  }
}

function timeoutError(label: string, limitMs: number, grant: UploadGrant): UploadTransportError {
  return new UploadTransportError(
    `Upload of "${label}" did not finish within the ${formatSeconds(limitMs)} s allowed, so ` +
      "whether storage stored the file is unknown. On a slow link, pass a longer timeoutMs. " +
      sameGrantRetry(grant),
    { code: "timeout" },
  );
}

/** What to do when the upload may have been stored: the grant itself tells, on a retry. */
function sameGrantRetry(grant: UploadGrant): string {
  return (
    `Retrying with the same grant before it expires at ${grant.expires_at} either stores ` +
    "the file or reports the grant as used, and then the grant's uri already names the file."
  );
}

function formatSeconds(ms: number): string {
  return String(Number((ms / 1_000).toFixed(3)));
}

/** A message whose own final period would double the one the sentence adds after it. */
function withoutFinalPeriod(message: string): string {
  return message.replace(/\.\s*$/, "");
}

/**
 * The first `maxBytes` of storage's error body as text: whatever arrived before the body
 * ended, failed, reached the cap or was cut short by `abort`, since even a partial body
 * may carry S3's code. The rest is cancelled unread, and the cancellation is never
 * awaited, since a stream's cancel can outlive any time limit.
 */
async function readErrorPrefix(
  response: Response,
  maxBytes: number,
  abort: AbortSignal,
): Promise<string> {
  if (response.body === null) return "";
  const reader = response.body.getReader();
  // Cancelled explicitly on abort, on top of the request's own abort, so a stalled body
  // never holds the read past the time limit: a cancel ends a pending read at once.
  const cancel = (): void => {
    void reader.cancel().catch(() => undefined);
  };
  if (abort.aborted) {
    cancel();
    return "";
  }
  abort.addEventListener("abort", cancel, { once: true });
  const decoder = new TextDecoder();
  let text = "";
  let received = 0;
  try {
    while (received < maxBytes) {
      const chunk = await reader.read();
      if (chunk.done) break;
      const bytes = chunk.value.subarray(0, maxBytes - received);
      received += bytes.byteLength;
      text += decoder.decode(bytes, { stream: true });
    }
    if (received >= maxBytes) cancel();
  } catch {
    // The body failed mid-stream, or a runtime errored it on abort: what arrived stands.
  } finally {
    abort.removeEventListener("abort", cancel);
  }
  return text + decoder.decode();
}

/**
 * The grant's URL, parsed before anything is sent. A runtime that cannot build a request
 * from a URL names the whole URL in its error — Node and Chrome both do, for one that does
 * not parse or that carries user info — and a browser resolves a relative one against the
 * page, which would send the credential to the page's own origin. So only an absolute
 * `http(s)` URL with no user info is sent, and the refusal names none of it.
 */
function storageTarget(grant: UploadGrant, label: string): URL {
  let target: URL | undefined;
  try {
    target = new URL(grant.url);
  } catch {
    target = undefined;
  }
  if (
    target === undefined ||
    (target.protocol !== "https:" && target.protocol !== "http:") ||
    target.username !== "" ||
    target.password !== ""
  ) {
    throw new UploadTransportError(
      `Upload of "${label}" was not sent: the grant's url is not an absolute http(s) URL ` +
        "free of user info, so it is not the one requestUploadGrant returned. Pass the grant " +
        "on unchanged.",
      { code: "invalid_grant_url" },
    );
  }
  return target;
}

/**
 * A network failure described by the names and codes along its cause chain:
 * "TypeError, caused by Error ENOTFOUND". Both are mutable, so each is kept only when it
 * is a bare identifier, which cannot hold a URL.
 */
function describeNetworkFailure(error: unknown): string {
  const parts: string[] = [];
  let current: unknown = error;
  for (let depth = 0; depth < 5 && current instanceof Error; depth++) {
    const name = isIdentifier(current.name) ? current.name : "Error";
    const code = (current as { code?: unknown }).code;
    parts.push(isIdentifier(code) ? `${name} ${code}` : name);
    current = current.cause;
  }
  return parts.length > 0 ? parts.join(", caused by ") : "a non-Error rejection";
}

function isIdentifier(value: unknown): value is string {
  return typeof value === "string" && /^[A-Za-z][A-Za-z0-9_]{0,63}$/.test(value);
}

/** Storage's own error, read off the S3 XML body. Either field is absent on another body. */
interface StorageRefusal {
  code: string | undefined;
  message: string | undefined;
}

/** Read `<Code>` and `<Message>` off an S3 error document. No XML parser: Node has none. */
function parseStorageError(body: string): StorageRefusal {
  return {
    code: xmlElementText(body, "Code"),
    message: xmlElementText(body, "Message"),
  };
}

function xmlElementText(body: string, element: string): string | undefined {
  const match = new RegExp(`<${element}>([^<]*)</${element}>`).exec(body);
  if (!match?.[1]) return undefined;
  return match[1]
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&");
}

function describeStatus(response: Response, refusal: StorageRefusal): string {
  const reason = refusal.code ?? response.statusText;
  return reason ? `${response.status} ${reason}` : String(response.status);
}

/**
 * What a `4xx` from storage means for the caller: the code it branches on, and words
 * it can act on. An expired grant and an unsigned header both answer `403
 * AccessDenied`, so only S3's message tells them apart.
 */
function classifyRefusal(
  status: number,
  refusal: StorageRefusal,
  grant: UploadGrant,
): { code: RejectedAssetCode; advice: string } {
  if (status === 412) {
    return {
      code: "grant_used",
      advice:
        "this grant was already used. A grant writes one object, once. If an earlier attempt " +
        "with it failed at storage, that attempt may have stored the file under the grant's " +
        "URI; otherwise request a new grant.",
    };
  }
  if (refusal.code === "SignatureDoesNotMatch") {
    return {
      code: "signature_mismatch",
      advice:
        "the file's size, content type or metadata differ from what the grant signed. Send " +
        "exactly the file the grant was requested for, with the grant's headers unchanged.",
    };
  }
  if (refusal.message && /expired/i.test(refusal.message)) {
    return {
      code: "grant_expired",
      advice: `the grant expired at ${grant.expires_at}. Request a new grant.`,
    };
  }
  if (refusal.message && /not signed/i.test(refusal.message)) {
    return {
      code: "unsigned_header",
      advice:
        "the request carried a header the grant did not sign. Send the grant's headers and " +
        "no other storage header.",
    };
  }
  return {
    code: "store_refused",
    advice:
      refusal.message ??
      "request a new grant, or check the file against the one it was requested for.",
  };
}

/** The file's own name when it has one (`File`), else the object name the grant's URI ends in. */
function fileLabel(grant: UploadGrant, file: Blob): string {
  const name = (file as { name?: unknown }).name;
  if (typeof name === "string" && name.length > 0) return name;
  const tail = grant.uri.slice(grant.uri.lastIndexOf("/") + 1);
  return tail.length > 0 ? tail : grant.uri;
}
