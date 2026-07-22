/**
 * `uploadFile` — the single-asset upload convenience over the raw `upload()` wire
 * call. Accepts web byte types in every runtime (`Blob`/`File`/`ArrayBuffer`/
 * `Uint8Array`) and, in Node only, a filesystem path string; returns an
 * {@link UploadRecord} assembled client-side. See `docs/input-preparation.md`.
 *
 * The MIME type and size are known client-side at upload time, so the record is
 * built without extending the `/v1/upload` response.
 */

import {
  InvalidLocalSourceError,
  RejectedAssetError,
  UploadAuthenticationError,
  UploadTransportError,
  UnsupportedUploadCapabilityError,
} from "./errors.js";
import { ApiResponseError, ApiUnreachableError } from "./errors.js";

/** A local asset `uploadFile` accepts. A path string is Node-only (see {@link readLocalPath}). */
export type UploadableAsset = Blob | ArrayBuffer | Uint8Array | string;

/**
 * The record `uploadFile` returns for a prepared asset. Beyond the source identity
 * it guarantees the resulting `uri`, the MIME `contentType`, the `size` in bytes,
 * and the `filename`. A content checksum is deliberately not included — it is
 * best-effort at most, and within-preparation dedup keys on source identity.
 */
export interface UploadRecord {
  /** The `pipelex-storage://` reference for the uploaded asset. */
  uri: string;
  filename: string;
  /** MIME type, known client-side. Best-effort for raw bytes (falls back to `application/octet-stream`). */
  contentType: string;
  /** Size of the uploaded bytes. */
  size: number;
}

/** Per-call options for {@link uploadFile}. Fill in a filename/MIME for nameless byte sources. */
export interface UploadFileOptions {
  filename?: string;
  contentType?: string;
}

/** The subset of the client `uploadFile` needs — the raw base64 `upload` wire call. */
export interface UploadCapableClient {
  upload(input: { filename: string; data: string; content_type: string }): Promise<{
    uri: string;
    filename: string;
  }>;
}

const DEFAULT_CONTENT_TYPE = "application/octet-stream";
const DEFAULT_FILENAME = "upload.bin";

const EXTENSION_MIME: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  svg: "image/svg+xml",
  bmp: "image/bmp",
  tif: "image/tiff",
  tiff: "image/tiff",
  heic: "image/heic",
  pdf: "application/pdf",
  txt: "text/plain",
  csv: "text/csv",
  json: "application/json",
};

/** True when running under Node (has `process.versions.node`). */
export function isNodeRuntime(): boolean {
  return (
    typeof process !== "undefined" && process.versions != null && process.versions.node != null
  );
}

/** Filename tail of a path, splitting on both separators (no `node:path` import needed). */
function basename(path: string): string {
  const parts = path.split(/[\\/]/);
  return parts[parts.length - 1] || path;
}

/** MIME guess from a filename extension; `application/octet-stream` when unknown. */
export function guessContentType(filename: string): string {
  const dot = filename.lastIndexOf(".");
  if (dot < 0 || dot === filename.length - 1) return DEFAULT_CONTENT_TYPE;
  const ext = filename.slice(dot + 1).toLowerCase();
  return EXTENSION_MIME[ext] ?? DEFAULT_CONTENT_TYPE;
}

/**
 * Read a filesystem path into bytes — Node only. A path string in a non-Node
 * runtime cannot be read, so it fails as an invalid local source rather than
 * being silently misread as text or a URL. `node:fs/promises` is imported
 * dynamically so it never lands in a browser bundle.
 */
export async function readLocalPath(path: string): Promise<Uint8Array> {
  if (!isNodeRuntime()) {
    throw new InvalidLocalSourceError(
      `Cannot read the local path "${path}" outside Node — path strings are Node-only. ` +
        "In the browser or an edge runtime, pass the file as bytes (Blob/File/ArrayBuffer/Uint8Array).",
      path,
    );
  }
  try {
    const { readFile } = await import("node:fs/promises");
    return await readFile(path);
  } catch (cause) {
    throw new InvalidLocalSourceError(
      `Local file cannot be read: "${path}" (${(cause as { code?: string }).code ?? "read error"}).`,
      path,
      { cause },
    );
  }
}

/** Base64-encode bytes, cross-runtime (Buffer when present, else chunked btoa). */
export function bytesToBase64(bytes: Uint8Array): string {
  if (typeof Buffer !== "undefined") {
    return Buffer.from(bytes).toString("base64");
  }
  let binary = "";
  const chunk = 0x8000; // stay under the String.fromCharCode argument cap
  for (let index = 0; index < bytes.length; index += chunk) {
    binary += String.fromCharCode(...bytes.subarray(index, index + chunk));
  }
  return btoa(binary);
}

/** Bytes + a filename/MIME derived from whatever asset form was supplied. */
interface AssetBytes {
  bytes: Uint8Array;
  filename: string;
  contentType: string;
}

/** Normalize any accepted asset form into bytes plus a filename and MIME. */
async function toAssetBytes(
  asset: UploadableAsset,
  options: UploadFileOptions,
): Promise<AssetBytes> {
  if (typeof asset === "string") {
    const bytes = await readLocalPath(asset);
    const filename = options.filename ?? basename(asset);
    return { bytes, filename, contentType: options.contentType ?? guessContentType(filename) };
  }
  if (asset instanceof Uint8Array) {
    return assetBytesFromBuffer(asset, options);
  }
  if (asset instanceof ArrayBuffer) {
    return assetBytesFromBuffer(new Uint8Array(asset), options);
  }
  // Blob / File — File carries `.name`; both carry `.type`.
  const bytes = new Uint8Array(await asset.arrayBuffer());
  const name = options.filename ?? (asset as File).name;
  const filename = name && name.length > 0 ? name : DEFAULT_FILENAME;
  const contentType = options.contentType ?? (asset.type || guessContentType(filename));
  return { bytes, filename, contentType };
}

function assetBytesFromBuffer(bytes: Uint8Array, options: UploadFileOptions): AssetBytes {
  const filename = options.filename ?? DEFAULT_FILENAME;
  return { bytes, filename, contentType: options.contentType ?? guessContentType(filename) };
}

/**
 * Upload one local asset and return its {@link UploadRecord}. Maps the raw
 * `upload()` transport errors onto the semantic input-preparation errors: a
 * `413` is a rejected asset, `401`/`403` an auth failure, `404` an unsupported
 * upload capability, an unreachable host a transport failure.
 */
export async function uploadFile(
  client: UploadCapableClient,
  asset: UploadableAsset,
  options: UploadFileOptions = {},
): Promise<UploadRecord> {
  const { bytes, filename, contentType } = await toAssetBytes(asset, options);
  const data = bytesToBase64(bytes);
  let uploaded: { uri: string; filename: string };
  try {
    uploaded = await client.upload({ filename, data, content_type: contentType });
  } catch (error) {
    throw mapUploadError(error, filename);
  }
  return { uri: uploaded.uri, filename: uploaded.filename, contentType, size: bytes.length };
}

/** Translate a raw `upload()` transport error into the matching preparation error. */
function mapUploadError(error: unknown, filename: string): Error {
  if (error instanceof ApiResponseError) {
    switch (error.status) {
      case 413:
        return new RejectedAssetError(
          `The server rejected "${filename}": ${error.serverMessage ?? "asset exceeds the service size limit"}.`,
          filename,
          error.status,
          { cause: error },
        );
      case 401:
      case 403:
        return new UploadAuthenticationError(
          `Upload of "${filename}" was not authorized (${error.status}). Check the configured Pipelex API key.`,
          error.status,
          { cause: error },
        );
      case 404:
        return new UnsupportedUploadCapabilityError(
          "The configured Pipelex deployment does not support file upload (no /v1/upload route). " +
            "Upload is a hosted Pipelex capability.",
          { cause: error },
        );
      default:
        return new UploadTransportError(
          `Upload of "${filename}" failed (${error.status}): ${error.serverMessage ?? error.statusText}.`,
          { cause: error },
        );
    }
  }
  if (error instanceof ApiUnreachableError) {
    return new UploadTransportError(
      `Upload of "${filename}" could not reach the Pipelex API (${error.code ?? "unreachable"}).`,
      { cause: error },
    );
  }
  // Only errors thrown by the `client.upload()` call reach here — the local-source
  // and asset-type failures are raised in `toAssetBytes`, before this try block. A
  // custom client that throws something other than the two mapped types falls through
  // to a transport error.
  return error instanceof Error ? error : new UploadTransportError(String(error));
}
