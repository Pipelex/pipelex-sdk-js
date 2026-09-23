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
import type { UploadGrant } from "./product-models.js";

export type { UploadGrant, UploadGrantInput } from "./product-models.js";
// The classes `uploadWithGrant` raises, so a page can branch on them without the main entry.
export { InputPreparationError, RejectedAssetError, UploadTransportError } from "./errors.js";

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
 * - `RejectedAssetError` (`status` is storage's) — a `412`, when the grant was
 *   already used (a grant writes one object, once); a `403` when the file's size,
 *   type or metadata differ from what the grant signed, when the request carried a
 *   header the grant did not sign, or when the grant has expired; any other `4xx`.
 *   Each asks for a new grant, or for the file the grant was requested for.
 * - `UploadTransportError` — storage unreachable, a `5xx`, or a redirect, which is
 *   refused rather than followed. In a browser a refused cross-origin request looks
 *   like an unreachable host, so the message names that too.
 *
 * A `5xx` leaves it unknown whether the object was written: retrying with the same
 * grant either stores it or answers the `412` of a used grant. The grant is a
 * bearer capability, and nothing here logs it.
 */
export async function uploadWithGrant(
  grant: UploadGrant,
  file: Blob,
  options: UploadWithGrantOptions = {},
): Promise<GrantedUpload> {
  const label = fileLabel(grant, file);
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
    if (signal?.aborted) throw error;
    const detail = error instanceof Error ? error.message : String(error);
    throw new UploadTransportError(
      `Upload of "${label}" could not reach storage (${detail}). In a browser, a refused ` +
        "cross-origin request looks the same: check that the page may connect to the storage " +
        "origin (its CSP connect-src).",
      { cause: error },
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
    );
  }

  // Only the error's code and message are kept, never the body: S3 echoes the
  // canonical request on a signature mismatch, and with it the grant's credential.
  const refusal = parseStorageError(await response.text().catch(() => ""));
  if (response.status >= 400 && response.status < 500) {
    throw new RejectedAssetError(
      `Storage refused the upload of "${label}" (${describeStatus(response, refusal)}): ` +
        refusalAdvice(response.status, refusal, grant),
      label,
      response.status,
    );
  }
  throw new UploadTransportError(
    `Upload of "${label}" failed at storage (${describeStatus(response, refusal)})` +
      (refusal.message ? `: ${refusal.message}` : "") +
      ". Retrying with the same grant either stores the file or reports the grant as used.",
  );
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

/** What a `4xx` from storage means for the caller, in words it can act on. */
function refusalAdvice(status: number, refusal: StorageRefusal, grant: UploadGrant): string {
  if (status === 412) {
    return "this grant was already used. A grant writes one object, once; request a new grant.";
  }
  if (refusal.code === "SignatureDoesNotMatch") {
    return (
      "the file's size, content type or metadata differ from what the grant signed. Send " +
      "exactly the file the grant was requested for, with the grant's headers unchanged."
    );
  }
  if (refusal.message && /expired/i.test(refusal.message)) {
    return `the grant expired at ${grant.expires_at}. Request a new grant.`;
  }
  if (refusal.message && /not signed/i.test(refusal.message)) {
    return (
      "the request carried a header the grant did not sign. Send the grant's headers and " +
      "no other storage header."
    );
  }
  return (
    refusal.message ??
    "request a new grant, or check the file against the one it was requested for."
  );
}

/** The file's own name when it has one (`File`), else the object name the grant's URI ends in. */
function fileLabel(grant: UploadGrant, file: Blob): string {
  const name = (file as { name?: unknown }).name;
  if (typeof name === "string" && name.length > 0) return name;
  const tail = grant.uri.slice(grant.uri.lastIndexOf("/") + 1);
  return tail.length > 0 ? tail : grant.uri;
}
