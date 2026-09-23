/**
 * `uploadWithGrant` — send one file straight to Pipelex storage with an upload
 * grant (`PipelexApiClient.requestUploadGrant`, `POST /v1/upload/grant`). The
 * side that holds the credential requests the grant; the side that holds the
 * bytes, typically a browser page, sends them with this. See
 * `docs/input-preparation.md`.
 *
 * **This module is the browser-safe entry, `@pipelex/sdk/upload`.** Its runtime
 * import graph must never reach a Node builtin, `undici` or the client: a page
 * bundles it as is, with nothing marked external. It imports the error classes
 * and the wire types only, and `tests/upload-grant.test.ts` bundles it for the
 * browser with esbuild to hold it to that.
 */

import { RejectedAssetError, UploadTransportError } from "./errors.js";
import type { RejectedAssetCode } from "./errors.js";
import type { UploadGrant } from "./product-models.js";

export type { UploadGrant, UploadGrantInput } from "./product-models.js";
// The classes `uploadWithGrant` raises, so a page can branch on them without the main entry.
export { InputPreparationError, RejectedAssetError, UploadTransportError } from "./errors.js";
export type { RejectedAssetCode } from "./errors.js";

/** Per-call options for {@link uploadWithGrant}. */
export interface UploadWithGrantOptions {
  /**
   * Cancels the upload. A caller's abort propagates as the signal's own reason,
   * never wrapped, so it stays distinguishable from a failure.
   */
  signal?: AbortSignal;
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
 * - `UploadTransportError` (`status` is storage's when it answered) — storage
 *   unreachable, a `5xx`, storage timing out on the body (`400 RequestTimeout`,
 *   which wrote nothing), or a redirect, which is refused rather than followed. In a
 *   browser a refused cross-origin request looks like an unreachable host, so the
 *   message names that too. A grant whose `url` is not an absolute `http(s)` URL
 *   free of user info is refused the same way, before anything is sent.
 *
 * A `5xx` leaves it unknown whether the object was written: retrying with the same
 * grant either stores it or answers the `412` of a used grant, and then the grant's
 * `uri` may already name the file. The grant is a bearer capability: nothing here
 * logs it, and no error this throws carries its URL, storage's error body or a
 * runtime error that could hold either.
 */
export async function uploadWithGrant(
  grant: UploadGrant,
  file: Blob,
  options: UploadWithGrantOptions = {},
): Promise<GrantedUpload> {
  const label = fileLabel(grant, file);
  const target = storageTarget(grant, label);
  const { signal } = options;
  let response: Response;
  try {
    response = await fetch(grant.url, {
      method: "PUT",
      headers: grant.headers,
      body: file,
      // A presigned URL signs its host, so a redirect could never succeed; refusing
      // it keeps the file from being sent anywhere the grant did not name.
      redirect: "manual",
      signal,
    });
  } catch (error) {
    // The signal's reason, not the runtime's error: some runtimes reject with a
    // generic AbortError instead of the caller's own reason.
    if (signal?.aborted) throw signal.reason;
    // Neither the runtime's message nor the error itself is kept: either can carry the
    // request URL, and with it the grant's credential (Bun puts it on the error's `path`).
    throw new UploadTransportError(
      `Upload of "${label}" could not reach storage at ${target.origin} ` +
        `(${describeNetworkFailure(error)}). In a browser, a refused cross-origin request ` +
        "looks the same: check that the page may connect to the storage origin (its CSP " +
        "connect-src).",
    );
  }

  if (response.status >= 200 && response.status < 300) {
    await response.body?.cancel().catch(() => undefined);
    return { uri: grant.uri };
  }
  // A browser reports a refused redirect as an opaque response with status 0.
  if (response.type === "opaqueredirect" || (response.status >= 300 && response.status < 400)) {
    await response.body?.cancel().catch(() => undefined);
    throw new UploadTransportError(
      `Upload of "${label}" was redirected by storage, and the redirect was refused: a ` +
        "presigned upload is valid only at the URL it was signed for.",
      // A refused redirect in a browser is opaque, with status 0: no status reached us.
      { status: response.status || undefined },
    );
  }

  // Only the error's code and message are kept, never the body: S3 echoes the
  // canonical request on a signature mismatch, and with it the grant's credential.
  const body = await response.text().catch(() => {
    // A caller's abort errors the body stream too, and stays the caller's, unwrapped.
    // Chrome and Firefox error it with a generic AbortError, so the reason is the signal's.
    if (signal?.aborted) throw signal.reason;
    return "";
  });
  const refusal = parseStorageError(body);
  const status = response.status;
  if (status === 400 && refusal.code === "RequestTimeout") {
    throw new UploadTransportError(
      `Upload of "${label}" timed out at storage (${describeStatus(response, refusal)}): ` +
        "storage stopped waiting for the file's bytes and wrote nothing. Retry with the same " +
        `grant before it expires at ${grant.expires_at}, or with a new one.`,
      { status },
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
      (refusal.message ? `: ${refusal.message}` : "") +
      ". Retrying with the same grant either stores the file or reports the grant as used.",
    { status },
  );
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
    );
  }
  return target;
}

/**
 * A network failure described by the names and codes along its cause chain, which carry
 * no URL: "TypeError, caused by Error ENOTFOUND".
 */
function describeNetworkFailure(error: unknown): string {
  const parts: string[] = [];
  let current: unknown = error;
  for (let depth = 0; depth < 5 && current instanceof Error; depth++) {
    const code = (current as { code?: unknown }).code;
    const safeCode = typeof code === "string" && /^[A-Za-z][A-Za-z0-9_]{0,63}$/.test(code);
    parts.push(safeCode ? `${current.name} ${code}` : current.name);
    current = current.cause;
  }
  return parts.length > 0 ? parts.join(", caused by ") : "a non-Error rejection";
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
